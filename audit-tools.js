// src/audit-tools.js
import Docker from 'dockerode';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import { logger } from './utils.js';

const docker = new Docker();
const TEMP_DIR = config.tempContractDir;

function parseSolidityVersion(sourceCode) {
    if (!sourceCode) return null;
    const pragmaMatch = sourceCode.match(/pragma solidity ([^;]+);/);
    if (!pragmaMatch || !pragmaMatch[1]) return null;
    const versionConstraint = pragmaMatch[1].trim();
    const specificVersionMatch = versionConstraint.match(/=\s*(\d+\.\d+\.\d+)/);
    if (specificVersionMatch && specificVersionMatch[1]) {
        logger.debug(`[VersionParser] Found specific version: ${specificVersionMatch[1]}`);
        return specificVersionMatch[1];
    }
    const caretVersionMatch = versionConstraint.match(/\^\s*(\d+\.\d+\.\d+)/);
    if (caretVersionMatch && caretVersionMatch[1]) {
        logger.debug(`[VersionParser] Found caret version, using lower bound: ${caretVersionMatch[1]}`);
        return caretVersionMatch[1];
    }
    const rangeLowerBoundMatch = versionConstraint.match(/>=\s*(\d+\.\d+\.\d+)/);
    if (rangeLowerBoundMatch && rangeLowerBoundMatch[1]) {
        logger.debug(`[VersionParser] Found range, using lower bound: ${rangeLowerBoundMatch[1]}`);
        return rangeLowerBoundMatch[1];
    }
    logger.warn(`[VersionParser] Could not reliably parse specific version from pragma: '${versionConstraint}'. Using default.`);
    return null;
}
async function ensureTempDirExists() {
    try {
        await fs.access(TEMP_DIR);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(TEMP_DIR, { recursive: true });
        } else {
            throw error;
        }
    }
}

function cleanStdout(data) {
    const jsonStartIndex = data.indexOf('{');
    if (jsonStartIndex === -1) {
        return data;
    }
    const jsonEndIndex = data.lastIndexOf('}');
    if (jsonEndIndex === -1 || jsonEndIndex < jsonStartIndex) {
        return data;
    }

    return data.substring(jsonStartIndex, jsonEndIndex + 1);
}

export async function runAuditToolInDocker({ toolName, files, mainFilePath }) {
    if (!files || !Array.isArray(files) || files.length === 0) return { success: false, error: "Missing 'files' array." };
    if (!mainFilePath) return { success: false, error: "Missing 'mainFilePath'." };

    await ensureTempDirExists();
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const hostProjectDir = path.join(config.tempContractDir, uniqueId);
    const containerProjectDir = '/app';

    let container = null;
    try {
        const mainFile = files.find(f => f.path.includes(mainFilePath));
        if (!mainFile || !mainFile.content) {
            throw new Error(`Could not find content for main file path '${mainFilePath}' in fetched files.`);
        }

        const requiredVersion = parseSolidityVersion(mainFile.content);
        logger.info(`[DockerRunner] Parsed Solidity version requirement: ${requiredVersion || 'Default'}`);

        logger.info(`[DockerRunner] Recreating directory structure in ${hostProjectDir}`);
        for (const file of files) {
            let relativePath = file.path;
            const sourcesIndex = relativePath.indexOf('/sources/');
            if (sourcesIndex !== -1) { relativePath = relativePath.substring(sourcesIndex + '/sources/'.length); }
            if (relativePath.startsWith('project_/')) { relativePath = relativePath.substring('project_/'.length); }
            else if (relativePath.includes('/project_/')) { relativePath = relativePath.substring(relativePath.indexOf('/project_/') + '/project_/'.length); }
            else { relativePath = file.name || path.basename(file.path); logger.warn(`[DockerRunner] Using fallback relative path for ${file.path}: ${relativePath}`); }
            const hostFilePath = path.join(hostProjectDir, relativePath);
            const hostDirPath = path.dirname(hostFilePath);
            logger.debug(`[DockerRunner] Writing file: Original='${file.path}' -> Relative='${relativePath}' -> Host='${hostFilePath}'`);
            await fs.mkdir(hostDirPath, { recursive: true });
            await fs.writeFile(hostFilePath, file.content);
        }
        logger.info(`[DockerRunner] Finished writing ${files.length} source files.`);

        const containerTargetPath = path.join(containerProjectDir, mainFilePath).replace(/\\/g, '/');
        let baseCommandParts = toolName.split(' ');
        let toolExe = baseCommandParts[0];
        let toolArgs = baseCommandParts.slice(1);

        let fullToolCommand = [toolExe, containerTargetPath, ...toolArgs].join(' ');

        if (toolExe === 'slither' && !fullToolCommand.includes('--json')) {
            fullToolCommand += ' --json -';
            logger.info("[DockerRunner] Auto-added '--json -' to slither command.");
        }

        let finalCommand;
        if (requiredVersion && toolExe === 'slither') {
            const checkInstallCmd = `solc-select use ${requiredVersion} --check`;
            const installCmd = `solc-select install ${requiredVersion}`;
            const useCmd = `solc-select use ${requiredVersion}`;
            logger.info(`[DockerRunner] Will ensure solc ${requiredVersion} is available and selected`);
            finalCommand = ['sh', '-c',
                `if ! ${checkInstallCmd} >/dev/null 2>&1; then ` +
                `echo "Solc ${requiredVersion} not found, attempting install..."; ` +
                `${installCmd}; ` +
                `fi && ${useCmd} && ${fullToolCommand}`
            ];
        } else {
            finalCommand = fullToolCommand.split(' ');
            if (toolExe === 'slither') {
                logger.info(`[DockerRunner] No specific version parsed or tool is not Slither. Using default solc in image.`);
            }
        }

        logger.info(`[DockerRunner] Running final command array in container: ${JSON.stringify(finalCommand)}`);

        const containerOptions = {
            Image: config.auditToolImage,
            Cmd: finalCommand,
            WorkingDir: containerProjectDir,
            HostConfig: { Binds: [`${path.resolve(hostProjectDir)}:${containerProjectDir}`] },
            Tty: false, AttachStdout: true, AttachStderr: true,
        };

        container = await docker.createContainer(containerOptions);
        await container.start();
        logger.debug(`[DockerRunner] Container ${container.id.substring(0, 12)} started.`);
        logger.debug(`[DockerRunner] Attaching log stream...`);

        const stream = await container.logs({ follow: true, stdout: true, stderr: true });
        let stdoutData = ''; let stderrData = '';
        const demuxPromise = new Promise((resolve, reject) => {
            if (!container || !container.modem) { return reject(new Error("Docker modem unavailable.")); }
            container.modem.demuxStream(stream, { write: (chunk) => { stdoutData += chunk.toString('utf8'); } }, { write: (chunk) => { stderrData += chunk.toString('utf8'); } });
            stream.on('end', () => { logger.debug('[DockerRunner] Log stream ended.'); resolve(); });
            stream.on('error', (err) => { logger.error('[DockerRunner] Log stream error:', err); reject(err); });
        });

        logger.debug('[DockerRunner] Waiting for container exit and stream processing...');
        const [runResult] = await Promise.all([container.wait(), demuxPromise]);
        logger.debug('[DockerRunner] Container wait and stream processing finished.');
        logger.info(`[DockerRunner] Container finished with status code: ${runResult.StatusCode}`);
        logger.debug(`[DockerRunner] Raw Stdout:\n${stdoutData}`);
        if (stderrData) logger.debug(`[DockerRunner] Raw Stderr:\n${stderrData}`);

        let parsedJson = null;
        let parseError = null;
        let cleanedStdout = '';
        const jsonRequested = fullToolCommand.includes('--json');

        if (stdoutData && jsonRequested) {
            cleanedStdout = cleanStdout(stdoutData);
            try { parsedJson = JSON.parse(cleanedStdout); logger.info('[DockerRunner] Successfully parsed cleaned JSON output.'); }
            catch (e) { parseError = e; logger.warn(`[DockerRunner] Failed to parse cleaned JSON output: ${e.message}`); logger.debug(`[DockerRunner] Cleaned stdout failing parse:\n${cleanedStdout}`); }
        }

        if (runResult.StatusCode === 0 || (parsedJson && parsedJson.success === true)) {
            if (runResult.StatusCode !== 0) logger.warn(`[DockerRunner] Tool exited non-zero (${runResult.StatusCode}) but produced valid success JSON. Treating as success.`);
            else logger.info(`[DockerRunner] ${toolExe} executed successfully (Exit Code 0).`);
            const resultOutput = parsedJson || cleanedStdout || stderrData;
            return { success: true, output: resultOutput };
        } else {
            logger.error(`[DockerRunner] ${toolExe} execution failed. Status code: ${runResult.StatusCode}`);
            const errorMessage = `Execution failed with status code ${runResult.StatusCode}. Stderr: ${stderrData || '(empty)'}. Raw Stdout was: ${stdoutData || '(empty)'}. ${parseError ? `ParseError: ${parseError.message}` : ''}`;
            return { success: false, error: errorMessage };
        }

    } catch (error) {
        logger.error(`[DockerRunner] Error executing ${toolName}: ${error.message}`);
        logger.error(error.stack);
        return { success: false, error: `Internal Docker runner error during ${toolName}: ${error.message}` };
    } finally {
        if (container) {
            try { await container.remove({ force: true }); logger.debug(`[DockerRunner] Removed container ${container.id.substring(0, 12)}`); }
            catch (removeError) { logger.warn(`[DockerRunner] Failed to remove container: ${removeError.message}`); }
        }
        //  try { await fs.rm(hostProjectDir, { recursive: true, force: true }); logger.info(`[DockerRunner] Cleaned up temp directory ${hostProjectDir}`); }
        //  catch (cleanupError) { logger.error(`[DockerRunner] Failed to cleanup temp directory: ${cleanupError.message}`); }
    }
}

export async function runForgeTestInDocker({
    testContractCode,
    testContractFileName,
    files,
    originalContractFileName
}) {
    if (!testContractFileName?.endsWith('.t.sol')) return { success: false, error: "Test filename must end with '.t.sol'." };
    if (!originalContractFileName?.endsWith('.sol')) return { success: false, error: "Original filename must end with '.sol'." };
    if (!testContractCode) return { success: false, error: "Missing test contract code." };
    if (!files || !Array.isArray(files) || files.length === 0) {
        return { success: false, error: "Missing or invalid 'files' array argument for Forge test." };
    }

    await ensureTempDirExists();
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const hostProjectDir = path.join(TEMP_DIR, uniqueId);
    const hostTestDirPath = path.join(hostProjectDir, 'test');
    const hostSrcDirPath = path.join(hostProjectDir, 'src');
    const hostTestFilePath = path.join(hostTestDirPath, testContractFileName);
    const containerProjectDir = '/app';

    let container = null;

    try {
        const originalFile = files.find(f => f.path.includes(originalContractFileName));
        if (!originalFile || !originalFile.content) {
            return { success: false, error: `Could not find content for original contract '${originalContractFileName}' in fetched files.` };
        }
        const originalContractCode = originalFile.content;

        const requiredVersion = parseSolidityVersion(originalContractCode);
        logger.info(`[ForgeRunner] Parsed Solidity version requirement: ${requiredVersion || 'Default'}`);

        logger.info(`[ForgeRunner] Initializing temporary Foundry project in ${hostProjectDir}`);
        const initCommand = ['forge', 'init', '--force', containerProjectDir];

        const initContainerOptions = {
            Image: config.auditToolImage,
            Cmd: initCommand,
            WorkingDir: '/',
            HostConfig: {
                Binds: [`${path.resolve(hostProjectDir)}:${containerProjectDir}`],
                AutoRemove: true,
            },
            Tty: false,
        };

        try {
            const [initRunResult] = await docker.run(config.auditToolImage, initCommand, process.stdout, initContainerOptions);
            if (initRunResult.StatusCode !== 0) throw new Error(`'forge init' failed with status code ${initRunResult.StatusCode}.`);
            logger.info(`[ForgeRunner] 'forge init' completed successfully.`);
        } catch (initErr) {
            logger.error(`[ForgeRunner] Failed to run 'forge init' in container: ${initErr.message}`);
            throw initErr;
        }

        logger.info(`[ForgeRunner] Writing source files and test file to ${hostProjectDir}`);
        for (const file of files) {
            let relativePath = file.path;
            const sourcesIndex = relativePath.indexOf('/sources/');
            if (sourcesIndex !== -1) { relativePath = relativePath.substring(sourcesIndex + '/sources/'.length); }
            if (relativePath.startsWith('project_/')) { relativePath = relativePath.substring('project_/'.length); }
            else if (relativePath.includes('/project_/')) { relativePath = relativePath.substring(relativePath.indexOf('/project_/') + '/project_/'.length); }
            else { relativePath = file.name || path.basename(file.path); logger.warn(`[ForgeRunner] Using fallback relative path for ${file.path}: ${relativePath}`); }

            const hostFilePath = path.join(hostSrcDirPath, relativePath);
            const hostDirPath = path.dirname(hostFilePath);

            logger.debug(`[ForgeRunner] Writing source file: Original='${file.path}' -> Relative='${relativePath}' -> Host='${hostFilePath}'`);
            await fs.mkdir(hostDirPath, { recursive: true });
            await fs.writeFile(hostFilePath, file.content);
        }
        logger.info(`[ForgeRunner] Finished writing ${files.length} source files.`);

        await fs.mkdir(hostTestDirPath, { recursive: true });
        await fs.writeFile(hostTestFilePath, testContractCode);
        logger.info(`[ForgeRunner] Wrote test contract to ${hostTestFilePath}`);

        const remapping = "contracts/=src/contracts/";
        const baseTestCommand = ['forge', 'test', '--root', containerProjectDir, '--remappings', remapping].join(' ');

        let finalTestCommand;

        if (requiredVersion) {
            const checkInstallCmd = `solc-select use ${requiredVersion} --check`;
            const installCmd = `solc-select install ${requiredVersion}`;
            const useCmd = `solc-select use ${requiredVersion}`;
            logger.info(`[ForgeRunner] Will ensure solc ${requiredVersion} is available and selected for tests`);
            finalTestCommand = ['sh', '-c',
                `if ! ${checkInstallCmd} >/dev/null 2>&1; then ` +
                `echo "Solc ${requiredVersion} not found, attempting install..."; ` +
                `${installCmd}; ` +
                `fi && ${useCmd} && ${baseTestCommand}`
            ];
        } else {
            logger.info(`[ForgeRunner] No specific version parsed. Using default solc for tests.`);
            finalTestCommand = baseTestCommand.split(' ');
        }

        logger.info(`[ForgeRunner] Running final test command array in container: ${JSON.stringify(finalTestCommand)}`);

        const testContainerOptions = {
            Image: config.auditToolImage,
            Cmd: finalTestCommand,
            WorkingDir: containerProjectDir,
            HostConfig: { Binds: [`${path.resolve(hostProjectDir)}:${containerProjectDir}`] },
            Tty: false, AttachStdout: true, AttachStderr: true,
        };

        container = await docker.createContainer(testContainerOptions);
        await container.start();
        logger.debug(`[ForgeRunner] Test container ${container.id.substring(0, 12)} started.`);

        const stream = await container.logs({ follow: true, stdout: true, stderr: true });
        let stdoutData = ''; let stderrData = '';
        const demuxPromise = new Promise((resolve, reject) => {
            if (!container || !container.modem) { return reject(new Error("Docker modem unavailable.")); }
            container.modem.demuxStream(stream, { write: (chunk) => { stdoutData += chunk.toString('utf8'); } }, { write: (chunk) => { stderrData += chunk.toString('utf8'); } });
            stream.on('end', () => { logger.debug('[ForgeRunner] Log stream ended.'); resolve(); });
            stream.on('error', (err) => { logger.error('[ForgeRunner] Log stream error:', err); reject(err); });
        });

        const [runResult] = await Promise.all([container.wait(), demuxPromise]);
        const combinedOutput = `${stdoutData}\n${stderrData}`.trim();
        logger.info(`[ForgeRunner] Test container finished with status code: ${runResult.StatusCode}`);
        logger.debug(`[ForgeRunner] Combined Output:\n${combinedOutput}`);

        if (runResult.StatusCode === 0) {
            logger.info(`[ForgeRunner] Forge test completed successfully.`);
            return { success: true, output: combinedOutput };
        } else {
            logger.warn(`[ForgeRunner] Forge test finished non-zero (${runResult.StatusCode}).`);
            return { success: false, output: combinedOutput, error: `Forge test failed with exit code ${runResult.StatusCode}. See output for details.` };
        }

    } catch (error) {
        logger.error(`[ForgeRunner] Error executing forge test: ${error.message}`);
        logger.error(error.stack);
        return { success: false, error: `Internal Forge runner error: ${error.message}` };
    } finally {
        if (container) {
            try { await container.remove({ force: true }); logger.debug(`[ForgeRunner] Removed test container ${container.id.substring(0, 12)}`); }
            catch (removeError) { logger.warn(`[ForgeRunner] Failed to remove container: ${removeError.message}`); }
        }
        try { await fs.rm(hostProjectDir, { recursive: true, force: true }); logger.info(`[ForgeRunner] Cleaned up temp directory ${hostProjectDir}`); }
        catch (cleanupError) { logger.error(`[ForgeRunner] Failed to cleanup temp directory: ${cleanupError.message}`); }
    }
}
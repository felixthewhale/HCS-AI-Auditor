import Docker from 'dockerode';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import { logger } from './utils.js';

const docker = new Docker(); // Auto-detects connection
const TEMP_DIR = config.tempContractDir;

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

// Helper to clean stdout before JSON parsing
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

// ****** NEW HELPER FUNCTION ******
function calculateRelativePath(fullPath, logPrefix = "[PathHelper]") {
    if (!fullPath || typeof fullPath !== 'string') {
        logger.warn(`${logPrefix} Invalid input path: ${fullPath}`);
        return path.basename(fullPath || 'unknown_file'); // Fallback
    }

    // Pattern 1: Look for '/sources/' and take everything after it
    const sourcesIndex = fullPath.indexOf('/sources/');
    if (sourcesIndex !== -1) {
        let relative = fullPath.substring(sourcesIndex + '/sources/'.length);
        // Remove potential leading 'project_/' often found after '/sources/'
        if (relative.startsWith('project_/')) {
            relative = relative.substring('project_/'.length);
        }
        logger.debug(`${logPrefix} Path matched '/sources/': Original='${fullPath}' -> Relative='${relative}'`);
        return relative;
    }

    // Pattern 2: Look for an EVM address-like segment (e.g., /0x.../) and take everything after it
    // Regex matches '/0x' followed by 40 hex characters followed by '/'
    const evmPathMatch = fullPath.match(/\/0x[a-fA-F0-9]{40}\/(.+)$/);
    if (evmPathMatch && evmPathMatch[1]) {
        let relative = evmPathMatch[1];
         // Remove potential leading 'sources/' or 'project_/' after the EVM address part
         if (relative.startsWith('sources/')) {
             relative = relative.substring('sources/'.length);
         }
         if (relative.startsWith('project_/')) {
             relative = relative.substring('project_/'.length);
         }
        logger.debug(`${logPrefix} Path matched EVM address pattern: Original='${fullPath}' -> Relative='${relative}'`);
        return relative;
    }

    // Pattern 3: Fallback - Look for 'project_/' anywhere
    const projectIndex = fullPath.indexOf('/project_/');
     if (projectIndex !== -1) {
         let relative = fullPath.substring(projectIndex + '/project_/'.length);
         logger.debug(`${logPrefix} Path matched '/project_/': Original='${fullPath}' -> Relative='${relative}'`);
         return relative;
     }

    // Ultimate Fallback: Use basename
    logger.warn(`${logPrefix} Could not determine structured relative path for '${fullPath}'. Using basename.`);
    return path.basename(fullPath);
}
// ****** END HELPER FUNCTION ******

// --- Helper function to parse Solidity version ---
function parseSolidityVersion(sourceCode) {
    if (!sourceCode) return null;
    // Match 'pragma solidity ... ;'
    const pragmaMatch = sourceCode.match(/pragma solidity ([^;]+);/);
    if (!pragmaMatch || !pragmaMatch[1]) return null;

    const versionConstraint = pragmaMatch[1].trim();

    // Try to find a specific version (e.g., =0.6.12)
    const specificVersionMatch = versionConstraint.match(/=\s*(\d+\.\d+\.\d+)/);
    if (specificVersionMatch && specificVersionMatch[1]) {
        logger.debug(`[VersionParser] Found specific version: ${specificVersionMatch[1]}`);
        return specificVersionMatch[1];
    }

    // Try to find a caret version lower bound (e.g., ^0.6.0) -> use 0.6.0
    const caretVersionMatch = versionConstraint.match(/\^\s*(\d+\.\d+\.\d+)/);
    if (caretVersionMatch && caretVersionMatch[1]) {
        logger.debug(`[VersionParser] Found caret version, using lower bound: ${caretVersionMatch[1]}`);
        return caretVersionMatch[1]; // Use the specified lower bound
    }

    // Try to find a range lower bound (e.g., >=0.6.0 <0.7.0) -> use 0.6.0
    const rangeLowerBoundMatch = versionConstraint.match(/>=\s*(\d+\.\d+\.\d+)/);
     if (rangeLowerBoundMatch && rangeLowerBoundMatch[1]) {
         logger.debug(`[VersionParser] Found range, using lower bound: ${rangeLowerBoundMatch[1]}`);
         return rangeLowerBoundMatch[1];
     }

    // Add more complex range parsing if needed
    logger.warn(`[VersionParser] Could not reliably parse specific version from pragma: '${versionConstraint}'. Using default.`);
    return null; // Indicate fallback to default
}

export async function runAuditToolInDocker({ toolName, files, mainFilePath }) {
    if (!files || !Array.isArray(files) || files.length === 0) return { success: false, error: "Missing 'files' array." };
    if (!mainFilePath) return { success: false, error: "Missing 'mainFilePath'." };

    await ensureTempDirExists();
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const hostProjectDir = path.join(TEMP_DIR, uniqueId);
    const containerProjectDir = '/app';

    let container = null;
    try {
        // --- Find Main File Content ---
        const mainFile = files.find(f => f.path.includes(mainFilePath)); // Find by unique path segment
        if (!mainFile || !mainFile.content) {
             throw new Error(`Could not find content for main file path '${mainFilePath}' in fetched files.`);
        }

        // --- Parse Solidity Version ---
        const requiredVersion = parseSolidityVersion(mainFile.content);
        logger.info(`[DockerRunner] Parsed Solidity version requirement: ${requiredVersion || 'Default'}`);

        // --- Recreate Directory Structure ---
        logger.info(`[DockerRunner] Recreating directory structure in ${hostProjectDir}`);
        for (const file of files) {
            // ****** USE HELPER FUNCTION ******
            const relativePath = calculateRelativePath(file.path, "[DockerRunner]");
            // *******************************

            const hostFilePath = path.join(hostProjectDir, relativePath); // Write to root of temp dir
            const hostDirPath = path.dirname(hostFilePath);

            logger.debug(`[DockerRunner] Writing file: Host='${hostFilePath}'`); // Simplified log
            await fs.mkdir(hostDirPath, { recursive: true });
            await fs.writeFile(hostFilePath, file.content);
        }
        logger.info(`[DockerRunner] Finished writing ${files.length} source files.`);

        // --- Prepare Command with Version Selection ---
        const containerTargetPath = path.join(containerProjectDir, mainFilePath).replace(/\\/g, '/');
        let baseCommand = [toolName]; // e.g., ['slither']
        let finalCommand = [];

        // Handle args embedded in toolName (like --json -)
        const toolParts = toolName.split(' ');
        baseCommand[0] = toolParts[0]; // Base tool command
        baseCommand.push(containerTargetPath); // Target the main file
        if (toolParts.length > 1) {
             baseCommand.push(...toolParts.slice(1)); // Add args like --json, -
        }

        // Ensure JSON output if Slither
        if (baseCommand[0] === 'slither' && !baseCommand.includes('--json')) {
             baseCommand.push('--json', '-');
             logger.info("[DockerRunner] Auto-added '--json -' to slither command.");
        }

        if (requiredVersion && baseCommand[0] === 'slither') {
            const installCmd = `solc-select install ${requiredVersion}`;
            const useCmd = `solc-select use ${requiredVersion}`;
            const slitherCmd = `slither ${containerTargetPath} --json -`;
            logger.info(`[DockerRunner] Will install and use solc ${requiredVersion}`);
            // ****** SIMPLIFIED sh -c ******
            // Explicitly install (stdout/stderr silenced), then use (stdout silenced), then run slither
            finalCommand = ['sh', '-c',
                `${installCmd} >/dev/null 2>&1 ; ${useCmd} >/dev/null 2>&1 && ${slitherCmd}`
            ];
            // *****************************
        } else {
             finalCommand = baseCommand; // Use the base command directly
             if (baseCommand[0] === 'slither') {
                logger.info(`[DockerRunner] No specific version parsed or tool is not Slither. Using default solc in image.`);
             }
        }

        logger.info(`[DockerRunner] Running command in container: ${finalCommand.join(' ')}`);

        // --- Create and Run Container ---
        const containerOptions = {
            Image: config.auditToolImage,
            Cmd: finalCommand,
            WorkingDir: containerProjectDir, // Important: Run from the project root
            HostConfig: {
                Binds: [`${path.resolve(hostProjectDir)}:${containerProjectDir}`],
                AutoRemove: false,
            },
            Tty: false,
            AttachStdout: true,
            AttachStderr: true,
        };

        container = await docker.createContainer(containerOptions);
        await container.start();
        logger.debug(`[DockerRunner] Container ${container.id.substring(0,12)} started.`);

        const stream = await container.logs({ follow: true, stdout: true, stderr: true });
        let stdoutData = ''; let stderrData = '';
        const demuxPromise = new Promise((resolve, reject) => {
            if (!container || !container.modem) {
                 // Safety check in case container object is unexpected
                 return reject(new Error("Docker container or modem is not available for demuxing."));
            }
            // Use the modem to separate stdout and stderr
            container.modem.demuxStream(stream,
                { write: (chunk) => { stdoutData += chunk.toString('utf8'); } }, // Write stdout chunks to stdoutData
                { write: (chunk) => { stderrData += chunk.toString('utf8'); } }  // Write stderr chunks to stderrData
            );
            // Handle stream events
            stream.on('end', () => {
                logger.debug('[DockerRunner] Log stream ended.');
                resolve(); // Resolve the promise when the stream ends
            });
            stream.on('error', (err) => {
                logger.error('[DockerRunner] Log stream error:', err);
                reject(err); // Reject the promise if the stream errors
            });
             // Optional: Add a timeout in case the stream hangs unexpectedly
             // const streamTimeout = setTimeout(() => {
             //     logger.warn('[DockerRunner] Log stream timed out. Forcing rejection.');
             //     reject(new Error('Docker log stream timeout'));
             // }, 300000); // e.g., 5 minutes timeout
             // stream.on('end', () => clearTimeout(streamTimeout)); // Clear timeout on normal end
             // stream.on('error', () => clearTimeout(streamTimeout)); // Clear timeout on error
        });

        const [runResult] = await Promise.all([ container.wait(), demuxPromise ]);

        logger.info(`[DockerRunner] Container finished with status code: ${runResult.StatusCode}`);
        logger.debug(`[DockerRunner] Raw Stdout:\n${stdoutData}`);
        if (stderrData) logger.debug(`[DockerRunner] Raw Stderr:\n${stderrData}`);

       // --- Process Results ---
       let parsedJson = null;
       let parseError = null;
       let cleanedStdout = '';

       if (stdoutData && baseCommand.includes('--json')) { // Check if JSON was requested
           cleanedStdout = cleanStdout(stdoutData); // Use helper to remove junk
           try {
               parsedJson = JSON.parse(cleanedStdout);
               logger.info('[DockerRunner] Successfully parsed cleaned Slither JSON output.');
               logger.debug('[DockerRunner] Parsed Slither JSON:', JSON.stringify(parsedJson, null, 2)); // Log parsed JSON
           } catch (e) {
               parseError = e;
               logger.warn(`[DockerRunner] Failed to parse cleaned Slither JSON output: ${parseError.message}`);
               logger.debug(`[DockerRunner] Cleaned stdout that failed parsing:\n${cleanedStdout}`);
           }
       }

       // Decision Logic (Treat non-zero exit but valid JSON as success with findings)
       if (runResult.StatusCode === 0 || (parsedJson && parsedJson.success === true)) {
           if (runResult.StatusCode !== 0) {
               logger.warn(`[DockerRunner] Slither exited non-zero (${runResult.StatusCode}) but produced valid success JSON. Treating as success with findings.`);
           } else {
                logger.info(`[DockerRunner] ${toolParts[0]} executed successfully (Exit Code 0).`);
           }
           const resultOutput = parsedJson || cleanedStdout || stderrData;
           logger.debug(`[DockerRunner] Returning success with output type: ${parsedJson ? 'JSON' : 'string'}`);
           return { success: true, output: resultOutput };
       } else {
           // Definite failure (non-zero exit AND no valid success JSON parsed)
           logger.error(`[DockerRunner] ${toolParts[0]} execution failed. Status code: ${runResult.StatusCode}`);
           const errorMessage = `Execution failed with status code ${runResult.StatusCode}. ${stderrData ? `Stderr: ${stderrData}` : ''} ${parseError ? `ParseError: ${parseError.message}` : ''} Raw Output: ${stdoutData}`;
           return { success: false, error: errorMessage };
       }

    } catch (error) {
        logger.error(`[DockerRunner] Error executing ${toolName}: ${error.message}`);
        logger.error(error.stack);
        if (error.code === 'ECONNREFUSED' || error.message.includes('docker daemon')) {
            return { success: false, error: 'Docker daemon connection failed. Is Docker running and accessible?' };
        }
        return { success: false, error: `Internal Docker runner error: ${error.message}` };
    } finally {
        // Cleanup container and temp directory
        if (container) {
             try {
                 await container.remove({ force: true }); // Force remove container
                 logger.debug(`[DockerRunner] Removed container ${container.id.substring(0,12)}`);
             } catch (removeError) {
                 logger.warn(`[DockerRunner] Failed to remove container ${container?.id?.substring(0,12)}: ${removeError.message}`);
             }
         }
         try { await fs.rm(hostProjectDir, { recursive: true, force: true }); logger.info(`[DockerRunner] Cleaned up temp directory ${hostProjectDir}`); }
         catch (cleanupError) { logger.error(`[DockerRunner] Failed to cleanup temp directory: ${cleanupError.message}`); }
    }
}

/**
 * Runs a Solidity test contract using Foundry (forge test) inside a Docker container.
 */
export async function runForgeTestInDocker({
    testContractCode,
    testContractFileName,
    files
}) {
    // Input Validation
    if (!testContractFileName?.endsWith('.t.sol')) return { success: false, error: "Test filename must end with '.t.sol'." };
    if (!files || !Array.isArray(files) || files.length === 0) {
        return { success: false, error: "Missing or invalid 'files' array argument for Forge test." };
    }

    // Find the original contract code from the files array
    const originalFile = files.find(f => f.path.includes(originalContractFileName));
    if (!originalFile || !originalFile.content) {
        return { success: false, error: `Could not find content for original contract '${originalContractFileName}' in fetched files.` };
    }
    const originalContractCode = originalFile.content; // Get code for version parsing

    await ensureTempDirExists();
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const hostProjectDir = path.join(TEMP_DIR, uniqueId);
    const hostTestDirPath = path.join(hostProjectDir, 'test');
    const hostSrcDirPath = path.join(hostProjectDir, 'src'); // Base source directory
    const hostTestFilePath = path.join(hostTestDirPath, testContractFileName);
    // We don't need hostSrcFilePath explicitly anymore, the loop handles it
    const containerProjectDir = '/app';

    let container = null;

    try {
        // Parse Solidity Version from the actual original contract content
        const requiredVersion = parseSolidityVersion(originalContractCode);
        logger.info(`[ForgeRunner] Parsed Solidity version requirement: ${requiredVersion || 'Default'}`);

        // Initialize Foundry Project Structure (forge init)
        // We run forge init *inside the container* as it might rely on git/env vars
        // We need a preliminary container just for init
        logger.info(`[ForgeRunner] Initializing temporary Foundry project in ${hostProjectDir}`);
        const initCommand = ['forge', 'init', '--force', containerProjectDir]; // Keep --force
        const initContainerOptions = {
             Image: config.auditToolImage,
             Cmd: initCommand,
             WorkingDir: '/', // Start at root to init in /app
             HostConfig: {
                 Binds: [`${path.resolve(hostProjectDir)}:${containerProjectDir}`],
                 AutoRemove: true, // Remove after init
             },
             Tty: false,
        };

        try {
             const [initRunResult] = await docker.run(config.auditToolImage, initCommand, process.stdout, initContainerOptions);
             if (initRunResult.StatusCode !== 0) throw new Error(`'forge init' failed with status code ${initRunResult.StatusCode}.`);
             logger.info(`[ForgeRunner] 'forge init' completed successfully.`);
        } catch (initErr) { /* ... handle init error ... */ throw initErr; }

        // --- Write ALL Source Contracts AND Test Contract ---
        logger.info(`[ForgeRunner] Writing source files and test file to ${hostProjectDir}`);
        // Write Source Files first
        for (const file of files) {
            // Use the same robust relative path calculation as in runAuditToolInDocker
            let relativePath = calculateRelativePath(file.path, "[ForgeRunner]");

            // Prepend 'src/' to the relative path for writing within Foundry structure
            const hostFilePath = path.join(hostSrcDirPath, relativePath); // Write inside src/
            const hostDirPath = path.dirname(hostFilePath);

            logger.debug(`[ForgeRunner] Writing source file: Host='${hostFilePath}'`);
            await fs.mkdir(hostDirPath, { recursive: true });
            await fs.writeFile(hostFilePath, file.content);
        }
        logger.info(`[ForgeRunner] Finished writing ${files.length} source files.`);

         // Write Test File (ensure test dir exists)
         const hostTestFileDir = path.dirname(hostTestFilePath);
         await fs.mkdir(hostTestFileDir, { recursive: true });
         await fs.writeFile(hostTestFilePath, testContractCode);
         logger.info(`[ForgeRunner] Wrote test contract to ${hostTestFilePath}`);

        // --- Prepare Forge Test Command with RUNTIME Version Selection & Remappings ---
        // Define the necessary remapping: "contracts/" should point to "src/contracts/"
        const remapping = "contracts/=src/contracts/";
        // Base command now includes remappings
        const baseTestCommand = ['forge', 'test', '--root', containerProjectDir, '--remappings', remapping].join(' '); // Add remapping flag

        let finalTestCommand;

        if (requiredVersion) {
            const installCmd = `solc-select install ${requiredVersion}`;
            const useCmd = `solc-select use ${requiredVersion}`;
            // baseTestCommand already includes remappings
            logger.info(`[ForgeRunner] Will install and use solc ${requiredVersion} for tests`);
             // ****** SIMPLIFIED sh -c ******
            finalTestCommand = ['sh', '-c',
                 `${installCmd} >/dev/null 2>&1 ; ${useCmd} >/dev/null 2>&1 && ${baseTestCommand}`
            ];
        } else {
            logger.info(`[ForgeRunner] No specific version parsed. Using default solc for tests.`);
            // Split the base command (with remappings) if no version selection needed
            finalTestCommand = baseTestCommand.split(' ');
        }

        logger.info(`[ForgeRunner] Running final test command array in container: ${JSON.stringify(finalTestCommand)}`);

        const testContainerOptions = {
            Image: config.auditToolImage,
            Cmd: finalTestCommand,
            WorkingDir: containerProjectDir,
            HostConfig: {
                Binds: [`${path.resolve(hostProjectDir)}:${containerProjectDir}`],
                AutoRemove: false,
            },
            Tty: false,
            AttachStdout: true,
            AttachStderr: true,
        };

        container = await docker.createContainer(testContainerOptions);
        await container.start();
        logger.debug(`[ForgeRunner] Test container ${container.id.substring(0,12)} started.`);

        const stream = await container.logs({ follow: true, stdout: true, stderr: true });
        let stdoutData = ''; let stderrData = '';
        const demuxPromise = new Promise((resolve, reject) => {
            if (!container || !container.modem) { return reject(new Error("Docker modem unavailable.")); }
            container.modem.demuxStream(stream, { write: (chunk) => { stdoutData += chunk.toString('utf8'); } }, { write: (chunk) => { stderrData += chunk.toString('utf8'); } });
            stream.on('end', () => { logger.debug('[ForgeRunner] Log stream ended.'); resolve(); });
            stream.on('error', (err) => { logger.error('[ForgeRunner] Log stream error:', err); reject(err); });
        });

        const [runResult] = await Promise.all([ container.wait(), demuxPromise ]);
        const combinedOutput = `${stdoutData}\n${stderrData}`.trim();
        logger.info(`[ForgeRunner] Test container finished with status code: ${runResult.StatusCode}`);
        logger.debug(`[ForgeRunner] Combined Output:\n${combinedOutput}`);

        if (runResult.StatusCode === 0) {
            logger.info(`[ForgeRunner] Forge test completed successfully.`);
            return { success: true, output: combinedOutput };
        } else {
            logger.warn(`[ForgeRunner] Forge test finished non-zero (${runResult.StatusCode}).`);
            // Include combined output in the error field as well for Gemini context
            return { success: false, output: combinedOutput, error: `Forge test failed with exit code ${runResult.StatusCode}. See output for details.` };
        }

    } catch (error) {
        logger.error(`[ForgeRunner] Error executing forge test: ${error.message}`);
        logger.error(error.stack);
        return { success: false, error: `Internal Forge runner error: ${error.message}` };
    } finally {
        // Cleanup
         if (container) {
             try { await container.remove({ force: true }); logger.debug(`[ForgeRunner] Removed test container ${container?.id?.substring(0,12)}`); }
             catch (removeError) { logger.warn(`[ForgeRunner] Failed to remove container: ${removeError.message}`); }
         }
         try { await fs.rm(hostProjectDir, { recursive: true, force: true }); logger.info(`[ForgeRunner] Cleaned up temp directory ${hostProjectDir}`); }
         catch (cleanupError) { logger.error(`[ForgeRunner] Failed to cleanup temp directory: ${cleanupError.message}`); }
    }
}
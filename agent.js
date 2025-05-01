// src/agent.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from './config.js';
import { systemInstruction, tools } from './prompts.js';
import { runAuditToolInDocker, runForgeTestInDocker } from './audit-tools.js';
import { listenForAuditRequests, sendAuditResult, initializeHederaClient } from './hedera-hcs.js';
import { logger, fetchVerifiedSource } from './utils.js';

const availableFunctions = {
    getSourceCode: fetchVerifiedSource,
    runAuditToolInDocker,
    executeSolidityTest: runForgeTestInDocker,
};

const SIMULATE_REQUEST = false;

const genAI = new GoogleGenerativeAI(config.googleApiKey);
const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: systemInstruction,
    tools: tools,
});

async function processAuditRequest(requestData) {
    const { contract_id_from_user, user_query, reply_topic_id, requestor_account_id } = requestData;
    logger.info(`[Agent] Starting process for user query: "${user_query}" from ${requestor_account_id}`);

    const chat = model.startChat();
    const initialUserPrompt = `"${user_query}"`;

    logger.info(`[Agent] Sending initial prompt to Gemini: ${initialUserPrompt}`);
    let result = await chat.sendMessage(initialUserPrompt);

    let loopCount = 0;
    const MAX_LOOPS = 15;
    let fetchedFiles = null;
    let fetchedMainFilePath = null;

    while (loopCount < MAX_LOOPS) {
        loopCount++;
        const response = result.response;

        if (!response) {
            logger.error("[Agent] Gemini response was empty or undefined.");
            await reportFinalError(reply_topic_id, contract_id_from_user, "AI response was empty.", SIMULATE_REQUEST);
            return;
        }
        const candidate = response.candidates?.[0];
        if (!candidate) {
            logger.error("[Agent] Gemini response contained no candidates.");
            await reportFinalError(reply_topic_id, contract_id_from_user, "AI response contained no candidates.", SIMULATE_REQUEST);
            return;
        }
        const finishReason = candidate.finishReason;
        if (finishReason !== 'TOOL_CALLS' && finishReason !== 'STOP') {
            logger.error(`[Agent] Gemini stopped unexpectedly. Reason: ${finishReason || 'Unknown'}. Content: ${JSON.stringify(candidate.content)}`);
            await reportFinalError(reply_topic_id, contract_id_from_user, `AI processing error: ${finishReason || 'Unknown'}`, SIMULATE_REQUEST);
            return;
        }

        if (candidate.content?.parts?.some(part => part.text)) {
            const textPart = candidate.content.parts.find(part => part.text).text;
            logger.info(`[Agent] Gemini Text Response:\n${textPart}`);
        }

        const functionCalls = candidate.content?.parts?.filter(part => part.functionCall)?.map(part => part.functionCall);

        if (finishReason === 'STOP' && (!functionCalls || functionCalls.length === 0)) {
            logger.info("[Agent] Gemini finished processing (STOP reason with no function calls).");
            if (!fetchedFiles) {
                logger.warn("[Agent] Gemini stopped before source code could be fetched successfully.");
                await reportFinalError(reply_topic_id, contract_id_from_user, "AI stopped before source code could be fetched.", SIMULATE_REQUEST);
            } else {
                logger.warn("[Agent] Gemini stopped without calling finalizeAuditReport. Sending error.");
                await reportFinalError(reply_topic_id, contract_id_from_user, "AI stopped unexpectedly before generating final report.", SIMULATE_REQUEST);
            }
        }

        if (finishReason === 'TOOL_CALLS' && (!functionCalls || functionCalls.length === 0)) {
            logger.error("[Agent] Gemini indicated TOOL_CALLS but provided no function calls. Stopping.");
            await reportFinalError(reply_topic_id, contract_id_from_user, "AI tool call error: No function calls provided.", SIMULATE_REQUEST);
            break;
        }

        const functionResponses = [];
        for (const fnCall of functionCalls) {
            const functionName = fnCall.name;
            const functionArgs = fnCall.args;
            logger.info(`[Agent] Gemini called function: ${functionName}`);
            logger.debug(`[Agent] Arguments for ${functionName}: ${JSON.stringify(functionArgs)}`);

            if (functionName === 'finalizeAuditReport') {
                logger.info(`[Agent] Audit complete. Received final report.`);
                const finalContractId = functionArgs.report?.contract_id || contract_id_from_user || "Unknown";
                await reportFinalResult(reply_topic_id, finalContractId, functionArgs.report, SIMULATE_REQUEST);
                return;
            }

            const func = availableFunctions[functionName];
            if (func) {
                try {
                    let functionResult;
                    if (functionName === 'getSourceCode') {
                        const contractIdArg = functionArgs?.contractId;
                        if (typeof contractIdArg !== 'string' || !contractIdArg.match(/^0\.0\.\d+$/)) {
                            functionResult = { success: false, error: `Invalid contractId format: ${JSON.stringify(contractIdArg)}` };
                        } else {
                            functionResult = await func(contractIdArg);
                        }

                        if (functionResult.success) {
                            fetchedFiles = functionResult.files;
                            fetchedMainFilePath = functionResult.mainFileName;
                            logger.info(`[Agent] Successfully stored fetched file data for ${contractIdArg}.`);
                        } else {
                            logger.warn(`[Agent] Source code fetch failed for ${contractIdArg}. Error will be sent to Gemini.`);
                            fetchedFiles = null;
                            fetchedMainFilePath = null;
                        }

                        functionResponses.push({ functionResponse: { name: functionName, response: functionResult } });
                    }
                    else if (functionName === 'runAuditToolInDocker') {
                        if (!fetchedFiles || !fetchedMainFilePath) {
                            throw new Error(`Cannot execute tool '${functionName}' because source file data has not been successfully fetched yet.`);
                        }

                        let modifiedArgs = {
                            toolName: functionArgs.toolName,
                            files: fetchedFiles,
                            mainFilePath: fetchedMainFilePath
                        };
                        if (!modifiedArgs.toolName) throw new Error("Missing toolName for runAuditToolInDocker");

                        logger.debug(`[Agent] Final modified args for ${functionName} (files omitted from log): { toolName: "${modifiedArgs.toolName}", mainFilePath: "${modifiedArgs.mainFilePath}", files: [...] }`);
                        functionResult = await func(modifiedArgs);

                        functionResponses.push({ functionResponse: { name: functionName, response: functionResult } });
                    }
                    else if (functionName === 'executeSolidityTest') {
                        if (!fetchedFiles || fetchedFiles.length === 0) {
                            throw new Error(`Cannot execute tool '${functionName}' because source file data has not been successfully fetched yet.`);
                        }
                        const originalFile = fetchedFiles.find(f => f.path.includes(functionArgs.originalContractFileName || fetchedMainFilePath));
                        const originalCode = originalFile ? originalFile.content : null;

                        if (!originalCode) {
                            throw new Error(`Could not find original contract content for '${functionArgs.originalContractFileName || fetchedMainFilePath}' in fetched files for ${functionName}.`);
                        }

                        let modifiedArgs = {
                            testContractCode: functionArgs.testContractCode,
                            testContractFileName: functionArgs.testContractFileName,
                            originalContractFileName: functionArgs.originalContractFileName || fetchedMainFilePath,
                            files: fetchedFiles
                        };
                        if (!modifiedArgs.testContractCode) throw new Error(`Missing 'testContractCode' for ${functionName}`);
                        if (!modifiedArgs.testContractFileName) throw new Error(`Missing 'testContractFileName' for ${functionName}`);
                        if (!modifiedArgs.originalContractFileName) throw new Error(`Missing 'originalContractFileName' for ${functionName}`);

                        const logArgs = { ...modifiedArgs, testContractCode: '...', files: `[${modifiedArgs.files.length} files]` };
                        logger.debug(`[Agent] Final modified args for ${functionName} (code/files omitted): ${JSON.stringify(logArgs)}`);
                        functionResult = await func(modifiedArgs);

                        functionResponses.push({ functionResponse: { name: functionName, response: functionResult } });
                    }
                } catch (hostError) {
                    logger.error(`[Agent] Error executing or preparing host function '${functionName}': ${hostError.message}`);
                    logger.error(hostError.stack);
                    functionResponses.push({ functionResponse: { name: functionName, response: { success: false, error: `Host execution error: ${hostError.message}` } } });
                }
            } else {
                logger.error(`[Agent] Gemini called unknown function: ${functionName}`);
                functionResponses.push({ functionResponse: { name: functionName, response: { success: false, error: `Function ${functionName} not found.` } } });
            }
        }

        if (functionResponses.length > 0) {
            result = await chat.sendMessage(functionResponses);
        } else {
            logger.warn("[Agent] No function calls processed or responses generated in loop. Breaking.");
            break;
        }

    }

    if (loopCount >= MAX_LOOPS) {
        logger.error(`[Agent] Audit process failed: Exceeded maximum agent loops (${MAX_LOOPS}).`);
        await reportFinalError(reply_topic_id, contract_id_from_user, 'Audit process timed out (max loops reached).', SIMULATE_REQUEST);
    }
}
async function reportFinalError(connectionTopicId, contractId, errorMessage, isSimulating) {
    logger.info(`[Agent] Entered reportFinalError for ${contractId || 'Unknown'} (Connection Topic: ${connectionTopicId}). Error: ${errorMessage}`);
    const effectiveContractId = contractId || "Unknown";

    const errorReportObject = {
        contract_id: effectiveContractId,
        score: 0,
        summary: `Audit failed for ${effectiveContractId}: ${errorMessage}`,
        findings: [{
            title: "Audit Process Error",
            severity: "Critical",
            description: `The automated audit process encountered an error: ${errorMessage}`,
            recommendation: "Review agent logs for details. The audit may be incomplete.",
            details: `Error occurred during processing for contract ${effectiveContractId}.`,
            confirmation: "N/A"
        }],
        tools_used: []
    };

    const finalPayload = { status: 'error', report: errorReportObject };

    if (!isSimulating) {
        if (connectionTopicId) {
            try {
                logger.info(`[Agent] Sending ERROR report for ${effectiveContractId} via HCS-10 to Connection Topic ${connectionTopicId}`);
                await sendAuditResult(connectionTopicId, effectiveContractId, finalPayload);
            } catch (e) {
                logger.error(`[Agent] Failed to send final ERROR result via HCS-10: ${e.message}`);
            }
        } else {
            logger.error(`[Agent] Cannot send error report via HCS-10: No Connection Topic ID was established for ${effectiveContractId}. Error was: ${errorMessage}`);
        }
    } else {
        logger.info(`[Agent Simulation] Audit failed for ${effectiveContractId}: ${errorMessage}. Would send HCS-10 error message here.`);
        logger.info("--- SIMULATED FINAL ERROR REPORT OUTPUT ---");
        console.log(JSON.stringify(finalPayload, null, 2));
        logger.info("--- END SIMULATED FINAL ERROR REPORT OUTPUT ---");
    }
}

async function reportFinalResult(connectionTopicId, contractId, report, isSimulating) {
    logger.info(`[Agent] Entered reportFinalResult for ${contractId} (Connection Topic: ${connectionTopicId})`);
    if (!report) {
        await reportFinalError(connectionTopicId, contractId, "Internal error: Final report object was missing.", isSimulating);
        return;
    }
    if (!isSimulating) {
        const reportObject = { status: 'success', report: report };
        try {
            await sendAuditResult(connectionTopicId, contractId, reportObject);
        } catch (e) {
            logger.error(`[Agent] Failed to send final SUCCESS result via HCS-10: ${e.message}`);
        }
    } else {
        logger.info(`[Agent Simulation] Final report generated for ${contractId}. Would send HCS message here.`);
        logger.info("--- SIMULATED FINAL REPORT OUTPUT ---");
        console.log(JSON.stringify({ status: 'success', report: report }, null, 2));
        logger.info("--- END SIMULATED FINAL REPORT OUTPUT ---");
    }
}

async function startAgent() {
    logger.info("Starting Hedera Audit Agent...");
    try {
        await initializeHederaClient();
    } catch (initError) {
        logger.error(`AGENT FAILED TO START: Client initialization failed critically. ${initError.message}`);
        process.exit(1);
    }

    if (SIMULATE_REQUEST) {
        logger.info("--- RUNNING IN SIMULATION MODE ---");
        const simulatedUserQuery = `Hello can you please audit the contract https://hashscan.io/mainnet/contract/0.0.1456985 thanks`;
        logger.info(`Simulating user query: "${simulatedUserQuery}"`);
        try {
            await processAuditRequest({
                user_query: simulatedUserQuery,
                contract_id_from_user: "0.0.SIMULATED",
                reply_topic_id: "0.0.DUMMYREPLY",
                requestor_account_id: "0.0.SIMULATOR"
            });
            logger.info("--- SIMULATION COMPLETE ---");
        } catch (simError) {
            logger.error(`--- SIMULATION FAILED ---`);
            logger.error(`Error during simulated processing: ${simError.message}`);
            logger.error(simError.stack);
            await reportFinalError("0.0.DUMMYREPLY", "0.0.SIMULATED", `Simulation failed: ${simError.message}`, true);
        }
    } else {
        logger.info("--- RUNNING IN HCS-10 LISTENER MODE ---");
        logger.info(`Listening for HCS-10 connection requests on Agent Inbound Topic ID: ${config.agentInboundTopicId}`);
        try {
            await listenForAuditRequests(processAuditRequest);
        } catch (listenError) {
            logger.error(`AGENT FAILED TO START HCS-10 LISTENING: ${listenError.message}`);
            process.exit(1);
        }
    }
}

startAgent().catch(error => {
    logger.error("AGENT FAILED UNEXPECTEDLY AT TOP LEVEL:", error);
    process.exit(1);
});
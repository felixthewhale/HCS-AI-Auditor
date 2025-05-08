// src/hedera-hcs.js
import {
    Client,
    ContractId,
    TopicMessageQuery,
    TopicCreateTransaction,
    TopicMessageSubmitTransaction,
    PrivateKey,
    TopicId,
    AccountId,
    Status,
    Timestamp
} from "@hashgraph/sdk";
import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { logger } from './utils.js';

const HCS_STATE_FILE = path.resolve('./hcs_state.json');
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;
const MAX_MESSAGE_SIZE_BYTES = 1024;

let hederaClient = null;
let isSubscribing = false;
let lastProcessedTimestamp = null;

async function loadLastTimestamp() {
    try {
        const data = await fs.readFile(HCS_STATE_FILE, 'utf8');
        const state = JSON.parse(data);
        if (state.lastProcessedTimestamp) {
            const savedDate = new Date(state.lastProcessedTimestamp);
            if (isNaN(savedDate.getTime())) {
                throw new Error(`Invalid date string in state file: ${state.lastProcessedTimestamp}`);
            }
            lastProcessedTimestamp = Timestamp.fromDate(savedDate);
            logger.info(`Loaded last processed timestamp: ${lastProcessedTimestamp.toString()}`);
        } else {
            logger.info('No last processed timestamp found in state file.');
            lastProcessedTimestamp = null;
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('HCS state file not found, starting from scratch.');
            lastProcessedTimestamp = null;
        } else {
            logger.error(`Failed to load HCS state file (${HCS_STATE_FILE}): ${error.message}`);
            lastProcessedTimestamp = null;
        }
    }
}
function buildHcs10Message(operation, operatorId, additionalFields = {}) {
    return JSON.stringify({
        p: "hcs-10",
        op: operation,
        operator_id: operatorId,
        ...additionalFields
    });
}

function getOperatorId() {
    return `${config.agentInboundTopicId}@${config.agentHederaAccountId}`;
}

async function createConnectionTopic(requesterAccountId, requesterInboundTopicId) {
    const client = await initializeHederaClient();
    const memo = `hcs-10:1:86400:2:${config.agentInboundTopicId}:${Date.now()}`;
    logger.info(`Creating HCS-10 connection topic for requester ${requesterAccountId} (from ${requesterInboundTopicId})`);

    const transaction = new TopicCreateTransaction()
        .setTopicMemo(memo)
        .setAdminKey(client.operatorPublicKey)
        .setSubmitKey(client.operatorPublicKey);

    const txResponse = await transaction.execute(client);
    const receipt = await txResponse.getReceipt(client);
    if (!receipt.topicId) throw new Error("Connection topic creation failed: No Topic ID in receipt.");

    logger.info(`Created connection topic: ${receipt.topicId.toString()}`);
    return receipt.topicId;
}

export async function handleConnectionRequest(message, processAuditRequestCallback) {
    try {
        if (!message || !message.contents) {
            throw new Error("Invalid message object received by handler.");
        }
        const messageContentString = Buffer.from(message.contents).toString('utf8');
        logger.debug(`[HCS-10 Handler] Decoded message content string: ${messageContentString.substring(0, 200)}...`);

        const parsedData = JSON.parse(messageContentString);

        if (parsedData.p !== "hcs-10" || parsedData.op !== "connection_request") {
            logger.warn(`[HCS-10 Handler] Received message on inbound topic is not a connection_request. Op: ${parsedData.op || 'N/A'}. Skipping handler.`);
            return;
        }

        const { operator_id: requesterOperatorId, m: auditQueryString } = parsedData;
        const requestSequenceNumber = message.sequenceNumber;

        if (!requesterOperatorId || !requesterOperatorId.includes('@')) {
            logger.error(`[HCS-10 Handler] Invalid or missing operator_id in connection_request: ${requesterOperatorId}. Skipping.`);
            return;
        }
        const [requesterInboundTopicId, requesterAccountId] = requesterOperatorId.split('@');

        logger.info(`[HCS-10 Handler] Processing connection_request #${requestSequenceNumber} from ${requesterOperatorId}`);

        if (!auditQueryString) {
            logger.warn("[HCS-10 Handler] Connection request missing audit query in 'm' field. Skipping.");
            return;
        }

        logger.info(`[HCS-10 Handler] Attempting to create connection topic for ${requesterAccountId}...`);
        const connectionTopicId = await createConnectionTopic(requesterAccountId, requesterInboundTopicId);
        if (!connectionTopicId) {
            logger.error(`[HCS-10 Handler] Failed to create connection topic for request #${requestSequenceNumber}. Aborting processing.`);
            return;
        }
        logger.info(`[HCS-10 Handler] Successfully created connection topic ${connectionTopicId.toString()}`);

        const connectionCreatedPayload = buildHcs10Message("connection_created", getOperatorId(), {
            connection_topic_id: connectionTopicId.toString(),
            connected_account_id: requesterAccountId,
            connection_id: Number(requestSequenceNumber)
        });
        try {
            await submitMessageToTopic(config.agentInboundTopicId, connectionCreatedPayload);
            logger.info(`[HCS-10 Handler] Sent connection_created for request #${requestSequenceNumber} on inbound topic ${config.agentInboundTopicId}`);
        } catch (submitError) {
            logger.error(`[HCS-10 Handler] Failed to submit connection_created message for request #${requestSequenceNumber}: ${submitError.message}`);
            return;
        }

        const contractIdMatch = auditQueryString.match(/\b(0\.0\.\d+)\b/);
        const contractIdFromUser = contractIdMatch ? contractIdMatch[1] : null;
        if (!contractIdFromUser) {
            logger.error(`[HCS-10 Handler] Could not extract contract ID from query: "${auditQueryString}". Skipping audit.`);
            const errorPayload = buildHcs10Message("message", getOperatorId(), { data: `Error: Could not parse contract ID from your request.` });
            try { await submitMessageToTopic(connectionTopicId, errorPayload); } catch { /* Ignore send error */ }
            return;
        }

        logger.info(`[HCS-10 Handler] Extracted contract ID ${contractIdFromUser}. Starting audit process...`);
        await processAuditRequestCallback({
            user_query: auditQueryString,
            contract_id_from_user: contractIdFromUser,
            reply_topic_id: connectionTopicId.toString(),
            requestor_account_id: requesterAccountId
        });
        logger.info(`[HCS-10 Handler] processAuditRequest initiated for request #${requestSequenceNumber}.`);

    } catch (error) {
        logger.error(`[HCS-10] Error handling connection request: ${error.message}`);
        logger.error(error.stack);
    }
}

async function saveLastTimestamp(timestamp) {
    if (!timestamp || !(timestamp instanceof Timestamp)) return;
    if (lastProcessedTimestamp && timestamp.compare(lastProcessedTimestamp) <= 0) { return; }

    lastProcessedTimestamp = timestamp;
    const state = { lastProcessedTimestamp: timestamp.toDate().toISOString() };
    try {
        await fs.writeFile(HCS_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
        logger.debug(`Saved last processed timestamp: ${timestamp.toString()}`);
    } catch (error) {
        logger.error(`Failed to save HCS state file (${HCS_STATE_FILE}): ${error.message}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function initializeHederaClient(attempt = 1) {
    if (hederaClient) return hederaClient;

    logger.info(`Attempting to initialize Hedera client (Attempt ${attempt}/${MAX_RETRIES})...`);
    try {
        const client = Client.forName(config.hederaNetwork);
        client.setOperator(
            AccountId.fromString(config.hederaAccountId),
            PrivateKey.fromString(config.hederaPrivateKey)
        );

        hederaClient = client;
        logger.info(`Hedera client initialized successfully for network: ${config.hederaNetwork}, operator: ${config.hederaAccountId}`);
        return hederaClient;
    } catch (error) {
        logger.error(`Hedera client initialization failed (Attempt ${attempt}/${MAX_RETRIES}): ${error.message}`);
        if (attempt < MAX_RETRIES) {
            const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
            logger.info(`Retrying client initialization in ${backoff / 1000} seconds...`);
            await sleep(backoff);
            return initializeHederaClient(attempt + 1);
        } else {
            logger.error(`FATAL: Maximum client initialization retries (${MAX_RETRIES}) reached. Exiting.`);
            process.exit(1);
        }
    }
}

async function attemptSubscription(auditProcessorCallback) {
    if (isSubscribing) {
        logger.warn("Subscription attempt already in progress. Skipping.");
        return;
    }
    isSubscribing = true;

    if (!hederaClient) {
        logger.error("Cannot subscribe: Hedera client not initialized.");
        isSubscribing = false;
        throw new Error("Hedera client not ready for subscription.");
    }

    const topicId = TopicId.fromString(config.agentInboundTopicId);
    logger.info(`Attempting to subscribe to HCS topic: ${topicId.toString()}`);

    let queryStartTime;
    if (lastProcessedTimestamp) {
        queryStartTime = lastProcessedTimestamp.plusNanos(1);
        logger.info(`Subscribing from timestamp: ${queryStartTime.toString()}`);
    } else {
        queryStartTime = Timestamp.fromDate(Date.now() - 60 * 1000);
        logger.info(`No previous timestamp found. Subscribing from ~1 minute ago: ${queryStartTime.toDate().toISOString()}`);
    }

    try {
        const subscription = new TopicMessageQuery()
            .setTopicId(topicId)
            .setStartTime(queryStartTime)
            .subscribe(
                hederaClient,
                async (message) => {
                    const sequenceNumber = message.sequenceNumber;
                    const consensusTimestamp = message.consensusTimestamp;

                    logger.debug(`[HCS Listener Raw Message] Seq: ${sequenceNumber}, TS: ${consensusTimestamp.toString()}, Message Object: ${JSON.stringify(message)}`);

                    logger.debug(`[HCS Listener] Attempting HCS-10 processing for Seq: ${sequenceNumber}.`);

                    try {
                        await handleConnectionRequest(message, auditProcessorCallback);
                        await saveLastTimestamp(consensusTimestamp);
                    } catch (handlerError) {
                        logger.error(`[HCS Listener] Error processing message (Seq: ${sequenceNumber}) in HCS-10 handler: ${handlerError.message}`);
                        logger.error(handlerError.stack);
                    }
                }
            );

        logger.info(`Successfully subscribed to HCS topic ${topicId.toString()}. Waiting for messages...`);
        isSubscribing = false;

    } catch (initialSubscribeError) {
        logger.error(`FATAL: Failed to establish initial HCS subscription to ${topicId.toString()}: ${initialSubscribeError.message}`);
        logger.error(initialSubscribeError.stack);
        isSubscribing = false;
        throw initialSubscribeError;
    }
}

export async function listenForAuditRequests(auditProcessorCallback) {
    if (isSubscribing) {
        logger.warn("listenForAuditRequests called, but subscription process already active.");
        return;
    }
    try {
        await initializeHederaClient();
        await loadLastTimestamp();
        await attemptSubscription(auditProcessorCallback);
    } catch (error) {
        logger.error(`[HCS Listener] Failed to start listening process: ${error.message}`);
        process.exit(1);
    }
}

export async function sendAuditResult(connectionTopicId, contractId, resultData, attempt = 1) {
    try {
        const client = await initializeHederaClient();
        logger.info(`[HCS-10 Sender] Entered sendAuditResult for ${contractId} to Connection Topic ${connectionTopicId}`);

        const fullReportString = JSON.stringify(resultData);
        logger.info(`[HCS-10 Sender] Calling inscribeDataToTopic for report size ${Buffer.byteLength(fullReportString, 'utf8')} bytes...`);

        const reportContentTopicId = await inscribeDataToTopic(fullReportString);
        if (!reportContentTopicId) {
            throw new Error("Failed to inscribe audit report data using HCS-1.");
        }
        logger.info(`[HCS-10 Sender] Inscribed full report for ${contractId} to HCS-1 topic ${reportContentTopicId}`);

        const hrl = `hcs://1/${reportContentTopicId.toString()}`;
        const hcs10Payload = buildHcs10Message("message", getOperatorId(), {
            data: hrl,
            m: `Audit result for ${contractId}`
        });

        logger.info(`[HCS-10 Sender] Sending HRL '${hrl}' to connection topic ${connectionTopicId}`);
        await submitMessageToTopic(connectionTopicId, hcs10Payload);

        logger.info(`[HCS-10 Sender] Successfully sent HRL reference for ${contractId} to connection topic ${connectionTopicId}`);

    } catch (error) {
        logger.error(`[HCS-10 Sender Attempt ${attempt}] Error sending HCS-10 result via ${connectionTopicId}: ${error.message}`);
        throw error;
    }
}

export async function createTopic(memo) {
    try {
        const client = await initializeHederaClient();
        if (!client) {
            logger.error("Failed to get initialized Hedera client in main function.");
            return;
        }

        logger.info("Creating a new Hedera topic...");

        const transaction = new TopicCreateTransaction()
            .setTopicMemo(memo)
            .setAdminKey(client.PrivateKey)
            .setSubmitKey(client.PrivateKey)
            ;

        const txResponse = await transaction.execute(client);
        logger.info("Fetching transaction receipt...");
        const receipt = await txResponse.getReceipt(client);
        const newTopicId = receipt.topicId;

        if (!newTopicId) {
            throw new Error("Topic ID was not found in the receipt. Topic creation might have failed implicitly.");
        }

        logger.info(`Successfully created new topic with ID: ${newTopicId.toString()} with MEMO ${memo}`);
        return newTopicId;

    } catch (error) {
        logger.error(`Error during topic creation: ${error.message}`);
        if (error.stack) {
            logger.error(error.stack);
        }
        return null;
    }
}

export function getClient() {
    if (!hederaClient) {
        throw new Error("Hedera client is not initialized.");
    }
    return hederaClient;
}

export async function submitMessageToTopic(topicId, message) {
    try {
        const client = await initializeHederaClient();
        if (!client) {
            logger.error("Failed to get initialized Hedera client in submitMessageToTopic.");
            return null;
        }

        if (!topicId) {
            throw new Error("Topic ID must be provided.");
        }
        if (message === undefined || message === null) {
            throw new Error("Message content must be provided.");
        }

        const messageBytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
        if (messageBytes.byteLength > MAX_MESSAGE_SIZE_BYTES) {
            throw new Error(`Message size (${messageBytes.byteLength} bytes) exceeds the maximum allowed size of ${MAX_MESSAGE_SIZE_BYTES} bytes for a single submission. Use inscribeDataToTopic for larger messages.`);
        }

        logger.info(`Submitting message to topic ${topicId.toString()}...`);

        const transaction = new TopicMessageSubmitTransaction()
            .setTopicId(topicId)
            .setMessage(message);

        const txResponse = await transaction.execute(client);
        logger.info("Fetching transaction receipt for message submission...");
        const receipt = await txResponse.getReceipt(client);

        if (receipt.status.toString() !== 'SUCCESS') {
            throw new Error(`Message submission failed with status: ${receipt.status.toString()}`);
        }

        const sequenceNumber = receipt.topicSequenceNumber;
        if (!sequenceNumber && sequenceNumber !== 0) {
            throw new Error("Sequence number was not found in the receipt. Message submission might have failed implicitly.");
        }

        logger.info(`Successfully submitted message to topic ${topicId.toString()}. Sequence number: ${sequenceNumber.toString()}`);
        return Number(sequenceNumber);

    } catch (error) {
        logger.error(`Error during message submission to topic ${topicId ? topicId.toString() : 'UNKNOWN'}: ${error.message}`);
        if (error.stack) {
            logger.error(error.stack);
        }
        return null;
    }
}

export async function inscribeDataToTopic(data) {
    let newTopicId = null;
    try {
        const client = await initializeHederaClient();
        if (!client) {
            logger.error("[Inscriber] Failed to get initialized Hedera client.");
            return null;
        }

        if (data === undefined || data === null) {
            throw new Error("[Inscriber] Data to inscribe must be provided.");
        }

        const topicMemo = `HCS-1 Data Topic - ${new Date().toISOString()}`;
        logger.info(`[Inscriber] Creating new HCS-1 data topic with memo: "${topicMemo}"`);
        const createTx = new TopicCreateTransaction()
            .setTopicMemo(topicMemo)
            .setAdminKey(client.operatorPublicKey)
            .setSubmitKey(client.operatorPublicKey);

        const createTxResponse = await createTx.execute(client);
        const createReceipt = await createTxResponse.getReceipt(client);

        if (createReceipt.status !== Status.Success || !createReceipt.topicId) {
            throw new Error(`Failed to create HCS-1 data topic. Status: ${createReceipt.status.toString()}`);
        }
        newTopicId = createReceipt.topicId;
        logger.info(`[Inscriber] Successfully created HCS-1 data topic: ${newTopicId.toString()}`);

        const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data.toString(), 'utf8');

        if (dataBuffer.length === 0) {
            logger.warn("[Inscriber] Data to inscribe is empty. Returning newly created (empty) topic ID.");
            return newTopicId;
        }

        logger.info(`[Inscriber] Data size: ${dataBuffer.length} bytes. Max chunk size: ${MAX_MESSAGE_SIZE_BYTES} bytes.`);
        const numChunks = Math.ceil(dataBuffer.length / MAX_MESSAGE_SIZE_BYTES);
        logger.info(`[Inscriber] Splitting data into ${numChunks} chunk(s) for topic ${newTopicId.toString()}.`);

        for (let i = 0; i < numChunks; i++) {
            const start = i * MAX_MESSAGE_SIZE_BYTES;
            const end = Math.min(start + MAX_MESSAGE_SIZE_BYTES, dataBuffer.length);
            const chunk = dataBuffer.subarray(start, end);

            logger.info(`[Inscriber] Submitting chunk ${i + 1}/${numChunks} (size: ${chunk.length} bytes) to topic ${newTopicId.toString()}...`);

            const submitTx = new TopicMessageSubmitTransaction()
                .setTopicId(newTopicId)
                .setMessage(chunk);

            const submitTxResponse = await submitTx.execute(client);
            const submitReceipt = await submitTxResponse.getReceipt(client);

            if (submitReceipt.status !== Status.Success) {
                throw new Error(`Failed to submit chunk ${i + 1}/${numChunks} to topic ${newTopicId.toString()}. Status: ${submitReceipt.status.toString()}`);
            }

            logger.info(`[Inscriber] Successfully submitted chunk ${i + 1}/${numChunks}. Sequence number: ${submitReceipt.topicSequenceNumber}`);
        }

        logger.info(`[Inscriber] Successfully inscribed all ${numChunks} chunks to topic ${newTopicId.toString()}.`);
        return newTopicId;

    } catch (error) {
        logger.error(`[Inscriber] Error during data inscription: ${error.message}`);
        logger.error(error.stack);
        return null;
    }
}
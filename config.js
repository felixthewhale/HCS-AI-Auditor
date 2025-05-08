// src/config.js
import dotenv from 'dotenv';
dotenv.config();

export const config = {
    googleApiKey: process.env.GOOGLE_API_KEY,
    hederaAccountId: process.env.HEDERA_ACCOUNT_ID,
    hederaPrivateKey: process.env.HEDERA_PRIVATE_KEY,
    hederaNetwork: process.env.HEDERA_NETWORK || 'testnet',
    logLevel: process.env.LOG_LEVEL || 'info',
    agentHederaAccountId: process.env.HEDERA_ACCOUNT_ID,
    agentInboundTopicId: process.env.AGENT_INBOUND_TOPIC_ID, // NEW: Agent's public HCS-10 inbound topic
    agentOutboundTopicId: process.env.AGENT_OUTBOUND_TOPIC_ID, // NEW: Agent's public HCS-10 outbound topic
    tempContractDir: './contracts-temp', // must exist and gitignored
    auditToolImage: 'hedera-audit-tools:latest'
};
console.log(config)
// Basic validation
if (!config.googleApiKey || !config.hederaAccountId || !config.hederaPrivateKey || !config.agentInboundTopicId /* || !config.agentOutboundTopicId */) {
    console.error("FATAL ERROR: Missing required environment variables (check API Key, Hedera credentials, Agent Topic IDs). Check .env file.");
    process.exit(1);
}
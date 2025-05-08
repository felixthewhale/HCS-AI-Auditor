// src/utils.js
import winston from 'winston';
import { config } from './config.js'; // Import config to get log level
import path from 'path';
import {
    ContractId,
} from "@hashgraph/sdk";
const { combine, timestamp, printf, colorize, align } = winston.format;

// Define the log format
const logFormat = printf(({ level, message, timestamp, stack }) => {
    // If stack trace exists (an error), print it. Otherwise, just the message.
    const msg = stack || message;
    return `${timestamp} [${level}]: ${msg}`;
});

export const logger = winston.createLogger({
    level: config.logLevel || 'info', // Use log level from config, default to 'info'
    format: combine(
        colorize({ all: true }), // Add colors
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), // Add timestamp
        align(), // Align log messages
        logFormat // Use the custom format defined above
    ),
    transports: [
        new winston.transports.Console(),
        // Optionally add file transport later if needed
        // new winston.transports.File({ filename: 'agent.log' })
    ],
    // Handle exceptions that aren't caught elsewhere
    // exceptionHandlers: [
    //     new winston.transports.Console(),
    //     // new winston.transports.File({ filename: 'exceptions.log' })
    // ],
    // // Handle promise rejections that aren't caught
    // rejectionHandlers: [
    //     new winston.transports.Console(),
    //     // new winston.transports.File({ filename: 'rejections.log' })
    // ]
});
/**
 * Queries the Hedera Mirror Node REST API for contract details.
 * @param {string} contractIdOrAddress - The contract ID (0.0.X) or EVM address (0x...).
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function queryMirrorNodeContract(contractIdOrAddress) {
    // Determine the correct Mirror Node base URL based on network
    let mirrorNodeUrl;
    switch (config.hederaNetwork.toLowerCase()) {
        case 'mainnet':
            mirrorNodeUrl = 'https://mainnet-public.mirrornode.hedera.com';
            break;
        case 'testnet':
            mirrorNodeUrl = 'https://testnet.mirrornode.hedera.com';
            break;
        // Add previewnet if needed
        default:
            logger.error(`[MirrorQuery] Unsupported Hedera network for Mirror Node: ${config.hederaNetwork}`);
            return { success: false, error: `Unsupported network: ${config.hederaNetwork}` };
    }

    const apiUrl = `${mirrorNodeUrl}/api/v1/contracts/${contractIdOrAddress}`;
    logger.debug(`[MirrorQuery] Querying Mirror Node: ${apiUrl}`);

    try {
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            let errorText = `Status: ${response.status}`;
            try {
                const errorData = await response.json();
                errorText = JSON.stringify(errorData);
            } catch (e) { /* Ignore */ }
            logger.warn(`[MirrorQuery] Failed to fetch contract details for ${contractIdOrAddress}. ${errorText}`);
            return { success: false, error: `Mirror Node API error (Status ${response.status}) for ${contractIdOrAddress}` };
        }

        const data = await response.json();
        logger.debug(`[MirrorQuery] Successfully fetched details for ${contractIdOrAddress}`);
        return { success: true, data: data };

    } catch (error) {
        logger.error(`[MirrorQuery] Network error fetching from Mirror Node for ${contractIdOrAddress}: ${error.message}`);
        return { success: false, error: `Network error querying Mirror Node: ${error.message}` };
    }
}

/**
 * Fetches verified source code files from the verification service.
 * Concatenates Solidity file contents.
 * @param {string} contractId - The contract ID (e.g., "0.0.12345").
 * @returns {Promise<{success: boolean, sourceCode?: string, mainFileName?: string, error?: string}>}
 */
export async function fetchVerifiedSource(contractId) {
    logger.debug(`[Fetcher] Attempting to fetch source for contract ID: ${contractId} (Type: ${typeof contractId})`);

    // Basic validation of input type
    if (typeof contractId !== 'string' || !contractId.match(/^0\.0\.\d+$/)) {
        const errorMsg = `Invalid contract ID format provided to fetchVerifiedSource: Expected '0.0.X' string, got ${JSON.stringify(contractId)}`;
        logger.error(errorMsg);
        return { success: false, error: errorMsg };
    }

    // --- Convert Hedera ID to EVM Address ---
// --- 1. Query Mirror Node for the EVM Address ---
    const mirrorResult = await queryMirrorNodeContract(contractId);
    let evmAddressForApi;
    let evmAddress;

    if (mirrorResult.success && mirrorResult.data?.evm_address) {
        evmAddressForApi = mirrorResult.data.evm_address;
        logger.info(`[Fetcher] Found EVM address ${evmAddressForApi} for ${contractId} via Mirror Node.`);
    } else {
        logger.warn(`[Fetcher] Could not get distinct EVM address for ${contractId} from Mirror Node. Falling back to long-zero address. Error: ${mirrorResult.error || 'No evm_address field'}`);
        // Fallback to long-zero format
        try {
             const contractIdObj = ContractId.fromString(contractId);
             const solidityAddress = contractIdObj.toSolidityAddress();
             evmAddressForApi = '0x' + solidityAddress;
             logger.info(`[Fetcher] Using fallback long-zero address: ${evmAddressForApi}`);
        } catch (convError) {
            logger.error(`[Fetcher] Failed during Hedera ID ${contractId} conversion for fallback: ${convError.message}`);
            return { success: false, error: `Internal error converting contract ID ${contractId} for fallback` };
        }
    }
    // --- Determine Network Code & Construct URL ---
    const networkCode = config.hederaNetwork === 'mainnet' ? '295' : null; // Only mainnet supported for now
    if (!networkCode) {
         const errorMsg = `Verification API network code not configured for network: ${config.hederaNetwork}`;
         logger.error(`[Fetcher] ${errorMsg}`);
         return { success: false, error: errorMsg };
    }
    const verificationApiUrl = `https://server-verify.hashscan.io/files/any/${networkCode}/${evmAddressForApi}`;
    logger.info(`[Fetcher] Fetching source code from verification API: ${verificationApiUrl}`);

    // --- Make API Request ---
    try {
        const response = await fetch(verificationApiUrl, { method: 'GET', headers: { 'Accept': 'application/json' } });

        // --- Handle HTTP Errors ---
        if (!response.ok) {
            let errorData;
            let errorText = `Status: ${response.status}`;
            try {
                // Try to get more detail from JSON error body
                errorData = await response.json();
                errorText = JSON.stringify(errorData);
            } catch (e) {
                // If not JSON, try plain text
                 try { errorText = await response.text(); } catch(e2) { /* Ignore */ }
            }

            if (response.status === 404 || errorData?.message?.includes("Files have not been found")) {
                logger.warn(`[Fetcher] Source code not found for ${contractId} via API (Status ${response.status}).`);
                return { success: false, error: `Verified source code not found for contract ${contractId}.` };
            } else {
                logger.error(`[Fetcher] API request failed for ${contractId}. Status: ${response.status}. Response: ${errorText}`);
                return { success: false, error: `API error fetching source code (Status ${response.status}).` };
            }
        }

        // --- Process Successful Response ---
        const data = await response.json(); // Parse success response as JSON
        // Validate structure
        if (!data || typeof data !== 'object' || !Array.isArray(data.files)) {
            logger.error(`[Fetcher] API response for ${contractId} was successful but had unexpected format.`);
            return { success: false, error: `Unexpected API response format for ${contractId}.` };
       }

       // --- Filter for VALID .sol files ---
       const solFiles = data.files.filter(file =>
            file && file.path && typeof file.path === 'string' &&
            file.path.toLowerCase().endsWith('.sol') &&
            typeof file.content === 'string'
       );

       if (solFiles.length === 0) {
            logger.warn(`[Fetcher] No valid .sol files with content found for ${contractId}.`);
            return { success: false, error: `No Solidity (.sol) files found for ${contractId}.` };
       }
        // Validate the structure of the success response
        if (!data || typeof data !== 'object' || !Array.isArray(data.files)) {
             logger.error(`[Fetcher] API response for ${contractId} was successful but had unexpected format: ${JSON.stringify(data)}`);
             return { success: false, error: `Unexpected API response format for ${contractId}.` };
        }

        // --- Determine Main File Name (heuristic) ---
        let mainSolFile = null;
        let mainSolFilePath = null; // Store the full path for Slither target
        for (const file of solFiles) {
             // Try to create a cleaner relative path for guessing
             let relativePath = file.path;
             const sourcesIndex = relativePath.indexOf('/sources/');
             if (sourcesIndex !== -1) { relativePath = relativePath.substring(sourcesIndex + '/sources/'.length); }
             if (relativePath.startsWith('project_/')) { relativePath = relativePath.substring('project_/'.length); }

            if (!mainSolFile && !relativePath.includes('/interfaces/') && !relativePath.includes('/libraries/')) {
                mainSolFile = path.basename(relativePath);
                mainSolFilePath = relativePath; // Keep the relative path to use as target
            }
        }
        // Fallback if heuristic failed
        if (!mainSolFile) {
             let firstPath = solFiles[0].path;
             const sourcesIndex = firstPath.indexOf('/sources/');
             if (sourcesIndex !== -1) { firstPath = firstPath.substring(sourcesIndex + '/sources/'.length); }
             if (firstPath.startsWith('project_/')) { firstPath = firstPath.substring('project_/'.length); }
             mainSolFile = path.basename(firstPath);
             mainSolFilePath = firstPath;
        }

        logger.info(`[Fetcher] Successfully fetched ${solFiles.length} .sol file(s) for ${contractId}. Main file guessed: ${mainSolFile} (Path: ${mainSolFilePath})`);

        logger.info(`[Fetcher] Successfully fetched and combined ${solFiles.length} .sol file(s) for ${contractId}. Main file guessed: ${mainSolFile}`);
        return { success: true, files: solFiles, mainFileName: mainSolFilePath }; // Return main file *path*

    } catch (error) {
        // Catch network errors (fetch failed) or JSON parsing errors for success response
        logger.error(`[Fetcher] Network or parsing error fetching source for ${contractId}: ${error.message}`);
        logger.error(error.stack);
        return { success: false, error: `Network/Parsing error fetching source code: ${error.message}` };
    }
}
logger.info('Logger initialized.'); 
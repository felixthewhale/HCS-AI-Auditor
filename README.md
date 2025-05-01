# HCS-AI Agent: Smart Contract Auditing on Hedera

**HCS-AI Agent** leverages AI and decentralized communication via Hedera Consensus Service (HCS) to provide automated/AI-assisted smart contract auditing.

## Project Description

**HCS-AI Agent** is a system designed to:

1.  **Receive Audit Requests:** Listen for requests submitted to its dedicated Hedera topic, following the HCS-10 standard.
2.  **Analyze Contracts:** Utilize Google's Gemini AI model to understand requests, fetch verified contract source code from services like HashScan, and plan an audit strategy.
3.  **Execute Tools:** Orchestrate containerized security tools (Slither for static analysis, Foundry for dynamic testing) via Docker.
4.  **Handle Solidity Versions:** Dynamically select and use the appropriate `solc` version required by the target contract using `solc-select` inside the Docker container.
5.  **Report Findings:** Synthesize results from the AI and tools into a structured JSON report.
6.  **Deliver Reports via HCS:** Use HCS-10 for communication flow and chunking data onto a temporary topic to deliver potentially large audit reports back to the requester via a private HCS connection topic.

The goal is to provide an accessible, automated, and verifiable way to get preliminary security insights for Hedera smart contracts, all coordinated on-chain.

*(Note: This agent focuses on Solidity contracts deployed on Hedera. HTS precompile interactions are noted but may not be fully testable with standard EVM tools.)*

## How it Works: Architecture

1.  **HCS-10 Communication:** The agent listens on its public **Inbound Topic** (`AGENT_INBOUND_TOPIC_ID`) for `connection_request` messages.
2.  **Connection Setup:** Upon receiving a valid request, it creates a private **Connection Topic** and sends a `connection_created` message back to its Inbound Topic.
3.  **AI Core (Gemini):** The agent uses Google Gemini with function calling capabilities to:
    *   Parse the user request (from the `m` field of the connection request).
    *   Call `fetchVerifiedSource` to get contract code.
    *   Call `runAuditToolInDocker` (with `solc-select`) to execute Slither.
    *   Call `executeSolidityTest` (with `solc-select` & remappings) to run generated Foundry tests.
    *   Synthesize results and call `finalizeAuditReport`.
4.  **Tooling (Docker):** Slither and Foundry run inside a Docker container (`hedera-audit-tools:latest`) managed by `dockerode`. This container includes `solc-select` for dynamic compiler version management.
5.  **Report Delivery (HCS-10):**
    *   The final JSON report is inscribed onto a temporary HCS topic (`inscribeDataToTopic`).
    *   An HCS-10 `message` containing the HRL (`hcs://1/<report_topic_id>`) is sent to the private **Connection Topic**.

*(A diagram illustrating this flow could be added here)*

## Setup & Usage

**(Prerequisites: Node.js, Docker, Hedera Testnet/Mainnet Account with HBAR)**

1.  **Clone the Repository:**
    ```bash
    git clone <your-repo-url>
    cd <your-repo-name>
    ```
2.  **Install Dependencies:**
    ```bash
    npm install
    ```
3.  **Build Docker Image:** (Ensure Docker daemon is running)
    *   Navigate to the directory containing the `Dockerfile` (e.g., `docker/`).
    *   Build the image:
        ```bash
        docker build -t hedera-audit-tools:latest .
        ```
4.  **Configure Environment (`.env`):**
    *   Copy `.env.example` to `.env`.
    *   Fill in your `GOOGLE_API_KEY`.
    *   Fill in your Hedera account credentials (`HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`).
    *   **Create HCS Topics:** Manually create two public HCS topics on your chosen Hedera network (e.g., using HashScan or SDK script):
        *   One for the agent's inbound requests.
        *   One for the agent's (optional) outbound logs.
    *   Update `AGENT_INBOUND_TOPIC_ID` and `AGENT_OUTBOUND_TOPIC_ID` in `.env` with the new topic IDs.
    *   Set `HEDERA_NETWORK` (e.g., `testnet` or `mainnet`).
5.  **Run the Agent:**
    ```bash
    node src/agent.js
    ```
    The agent will initialize and start listening on its inbound topic.

6.  **Submit an Audit Request:**
    *   Use a script or tool (like the included example snippet in `hedera-hcs.js` comments or a separate script) to submit an HCS-10 `connection_request` message to the agent's `AGENT_INBOUND_TOPIC_ID`.
    *   **Message Format:**
        ```json
        {
          "p": "hcs-10",
          "op": "connection_request",
          "operator_id": "YOUR_INBOUND_TOPIC_ID@YOUR_ACCOUNT_ID", // Your info
          "m": "Hello please audit contract 0.0.12345 👉👈" // Free form query
        }
        ```
7.  **Monitor Logs & Receive Result:**
    *   Observe the agent's console logs for progress.
    *   The agent will create a connection topic and send the HRL containing the report link to that topic. You'll need a separate client/listener for that connection topic to receive the final HRL.

## Example Interaction Snippet (Conceptual)

```javascript
// 1. Requester sends connection_request to Agent's Inbound Topic
//    Content: { p: "hcs-10", op: "connection_request", operator_id:"...", m:"Audit 0.0.X" }

// 2. Agent receives request, creates Connection Topic (e.g., 0.0.CONN)

// 3. Agent sends connection_created to Agent's Inbound Topic
//    Content: { p: "hcs-10", op: "connection_created", connection_topic_id:"0.0.CONN", ... }

// 4. Agent performs audit...

// 5. Agent inscribes report JSON to Temp Topic (e.g., 0.0.REPORT) using HCS-1

// 6. Agent sends HCS-10 message to Connection Topic (0.0.CONN)
//    Content: { p: "hcs-10", op: "message", data:"hcs://1/0.0.REPORT", ... }

// 7. Requester listens on Connection Topic (0.0.CONN), receives HRL, fetches report from 0.0.REPORT.
```

## Development Notes & Challenges

*   **HTS Precompile Testing:** Standard Foundry testing struggles with HTS precompiles. Tests generated by the AI may need significant modification or focus only on pure Solidity logic.
*   **HCS-10 Complexity:** Implementing the full standard (registry, advanced connection management) requires further development. This version uses a simplified 1-to-1 connection flow.
*   **Tool Errors:** Handling errors from underlying tools (Slither crashes, `solc` bugs like the "Unimplemented feature" with 0.6.12) requires robust error parsing and reporting back to the AI.
*   **Prompt Engineering:** Guiding the AI (Gemini) to correctly use the available tools, interpret their output (especially errors), and handle limitations (like HTS testing) is an ongoing process.

---

*This project was developed as part of the Hedera AI Agents Hackathon

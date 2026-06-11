import express from 'express';
import { paymentMiddleware } from '@x402/express';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';

const app = express();
const PORT = 3001;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    res.header("Access-Control-Allow-Methods", "*");
    res.header("Access-Control-Expose-Headers", "payment-required, payment-signature, x-payment, content-type");
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

// Initialize the Facilitator Client with the testnet-friendly URL
// We use the public testnet facilitator from x402.org
const facilitatorClient = new HTTPFacilitatorClient({
    url: "https://x402.org/"
});

// Step 4: Setup the Resource Server and register EVM (Base Sepolia) and SVM (Solana Devnet) schemes
const resourceServer = new x402ResourceServer(facilitatorClient)
    .register("eip155:84532", new ExactEvmScheme()) // Base Sepolia CAIP-2 ID
    .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme()); // Solana Devnet CAIP-2 ID

// Initialize the resource server to fetch active configurations
resourceServer.initialize()
    .then(() => {
        console.log("x402 Resource Server initialized successfully.");
    })
    .catch((err) => {
        console.error("Failed to initialize x402 Resource Server:", err);
    });

// Step 5: Define payment-gated routes using paymentMiddleware
// We accept both EVM Base Sepolia USDC and Solana Devnet SPL/native payments
const payToEvmAddress = "0x1234567890123456789012345678901234567890"; // Mock destination developer address
const payToSolAddress = "SolanaDevDestinationAddress11111111111111"; // Mock Solana destination developer address

app.use(
    paymentMiddleware(
        {
            "GET /premium-data": {
                accepts: [
                    {
                        scheme: "exact",
                        price: "$0.10", // 0.10 USDC
                        network: "eip155:84532", // Base Sepolia
                        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC Base Sepolia
                        payTo: payToEvmAddress,
                    },
                    {
                        scheme: "exact",
                        price: "$0.01", // 0.01 USDC
                        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // Solana Devnet
                        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // USDC Solana Devnet
                        payTo: payToSolAddress,
                    }
                ],
                description: "Premium access to valuable wallet telemetry dashboard",
            },
            "GET /dummy-paid-service": {
                accepts: [
                    {
                        scheme: "exact",
                        price: "$0.05", // 0.05 USDC
                        network: "eip155:84532", // Base Sepolia
                        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC Base Sepolia
                        payTo: payToEvmAddress,
                    },
                    {
                        scheme: "exact",
                        price: "$0.005", // 0.005 USDC
                        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // Solana Devnet
                        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // USDC Solana Devnet
                        payTo: payToSolAddress,
                    }
                ],
                description: "Dummy service execution under the x402 protocol",
            }
        },
        resourceServer
    )
);

// Route handlers - these only run after successful x402 validation by paymentMiddleware
app.get('/premium-data', (req, res) => {
    console.log("Access granted to /premium-data");
    res.json({
        success: true,
        premiumData: "Super-secret premium intelligence: Vaulta wallets are 100% secure!"
    });
});

app.get('/dummy-paid-service', (req, res) => {
    console.log("Access granted to /dummy-paid-service");
    res.json({
        success: true,
        result: "Dummy Paid Service has run successfully! Fueling the Web3 micro-economy."
    });
});

// Step 6: Start the Express server
app.listen(PORT, () => {
    console.log(`x402 Server running on port ${PORT}`);
});

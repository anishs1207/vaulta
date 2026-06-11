"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
    Wallet,
    Play,
    ArrowRight,
    RefreshCw,
    ShieldCheck,
    Cpu
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner, ClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme, toClientSvmSigner, ClientSvmSigner } from "@x402/svm";
import { createWalletClient, createPublicClient, custom, http, formatEther } from "viem";
import { baseSepolia } from "viem/chains";
import { ethers } from "ethers";

// Import Solana v1 VersionedTransaction to bridge window.solana (Phantom) with @solana/kit (v2)
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { getBase64EncodedWireTransaction, Address, createKeyPairSignerFromBytes } from "@solana/kit";

// Import local account derivation logic for fallback testing
import deriveAccounts from "@/lib/deriveAccounts";
import { getSolanaConnection } from "@/lib/networks";
import { Header, Footer } from "@/components/layout";
import "@/types";

// Step 3: Apply monkey-patch to ExactSvmScheme to automatically populate feePayer on the client side
// This avoids exceptions if the server or facilitator requirements omit the feePayer address.
if (ExactSvmScheme && ExactSvmScheme.prototype) {
    const originalCreatePaymentPayload = ExactSvmScheme.prototype.createPaymentPayload;
    ExactSvmScheme.prototype.createPaymentPayload = async function (x402Version, paymentRequirements) {
        if (!paymentRequirements.extra) {
            paymentRequirements.extra = {};
        }
        if (!paymentRequirements.extra.feePayer) {
            // Default to the signer's address (buyer pays transaction fee)
            // Access private signer field via structural casting to avoid ESLint 'any' errors
            paymentRequirements.extra.feePayer = (this as unknown as { signer: { address: string } }).signer.address;
        }
        return originalCreatePaymentPayload.call(this, x402Version, paymentRequirements);
    };
}

export default function X402ClientPage() {
    // Wallet connection states
    const [metaMaskAddress, setMetaMaskAddress] = useState<string | null>(null);
    const [phantomAddress, setPhantomAddress] = useState<string | null>(null);

    // Balance states
    const [ethBalance, setEthBalance] = useState<string>("0.00");
    const [solBalance, setSolBalance] = useState<string>("0.00");

    // Fallback local derived accounts
    const [localEvmAccount, setLocalEvmAccount] = useState<AccountInfo | null>(null);
    const [localSolAccount, setLocalSolAccount] = useState<AccountInfo | null>(null);
    const [usingLocalEvm, setUsingLocalEvm] = useState<boolean>(false);
    const [usingLocalSol, setUsingLocalSol] = useState<boolean>(false);

    // x402 signers
    const [evmSigner, setEvmSigner] = useState<ClientEvmSigner | null>(null);
    const [svmSigner, setSvmSigner] = useState<ClientSvmSigner | null>(null);

    // UI logs and response data
    const [logs, setLogs] = useState<string[]>([]);
    const [consoleOutput, setConsoleOutput] = useState<unknown>(null);
    const [isLoading, setIsLoading] = useState<boolean>(false);

    // Log helper
    const logAction = (msg: string) => {
        setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);
    };

    // Step 4: Load local derived developer accounts from Vaulta seed phrase if available
    useEffect(() => {
        const savedMnemonic = localStorage.getItem("vaulta_mnemonic");
        if (savedMnemonic) {
            try {
                const accounts = deriveAccounts(savedMnemonic);
                if (accounts.ethereum[0]) {
                    setLocalEvmAccount(accounts.ethereum[0]);
                    logAction(`Found local Vaulta EVM developer account: ${accounts.ethereum[0].address}`);
                }
                if (accounts.solana[0]) {
                    setLocalSolAccount(accounts.solana[0]);
                    logAction(`Found local Vaulta Solana developer account: ${accounts.solana[0].address}`);
                }
            } catch (err) {
                console.error("Local account derivation failed:", err);
            }
        }
    }, []);

    // Step 5: Implement MetaMask (EVM) Connection
    const connectMetaMask = async () => {
        setIsLoading(true);
        logAction("Initiating MetaMask connection...");
        try {
            const provider = (window as unknown as { ethereum?: Parameters<typeof custom>[0] }).ethereum;
            if (!provider) {
                throw new Error("MetaMask extension not detected in browser!");
            }

            const [address] = await (provider as { request(args: { method: string }): Promise<string[]> }).request({ method: "eth_requestAccounts" });
            setMetaMaskAddress(address);
            setUsingLocalEvm(false);
            logAction(`MetaMask connected: ${address}`);

            const walletClient = createWalletClient({
                account: address as `0x${string}`,
                chain: baseSepolia,
                transport: custom(provider)
            });

            const publicClient = createPublicClient({
                chain: baseSepolia,
                transport: http()
            });

            // Fetch Sepolia ETH balance
            const balanceWei = await publicClient.getBalance({ address: address as `0x${string}` });
            setEthBalance(parseFloat(formatEther(balanceWei)).toFixed(4));

            // Create x402-compatible EVM signer
            const customSigner = {
                address: address as `0x${string}`,
                async signTypedData(typedData: Parameters<ClientEvmSigner["signTypedData"]>[0]) {
                    logAction("MetaMask: Requested typed data signature (EIP-712/3009)...");
                    return await walletClient.signTypedData({
                        account: address as `0x${string}`,
                        domain: typedData.domain,
                        types: typedData.types,
                        primaryType: typedData.primaryType,
                        message: typedData.message
                    });
                }
            };
            const signer = toClientEvmSigner(customSigner, publicClient);
            setEvmSigner(signer);
            logAction("x402 EVM client signer successfully initialized.");
        } catch (err: unknown) {
            logAction(`MetaMask Error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setIsLoading(false);
        }
    };

    // Step 6: Implement Phantom (Solana) Connection
    const connectPhantom = async () => {
        setIsLoading(true);
        logAction("Initiating Phantom connection...");
        try {
            const provider = (window as unknown as { solana?: { connect(): Promise<void>; publicKey: { toString(): string }; signTransaction(tx: VersionedTransaction): Promise<{ signatures: Uint8Array[] }>; isPhantom?: boolean } }).solana;
            if (!provider || !provider.isPhantom) {
                throw new Error("Phantom extension not detected in browser!");
            }

            await provider.connect();
            const pubKey = provider.publicKey.toString();
            setPhantomAddress(pubKey);
            setUsingLocalSol(false);
            logAction(`Phantom connected: ${pubKey}`);

            // Fetch actual Solana Devnet balance
            try {
                const connection = getSolanaConnection("devnet");
                const balanceLamports = await connection.getBalance(new PublicKey(pubKey));
                setSolBalance((balanceLamports / 1e9).toFixed(4));
            } catch (balErr) {
                console.error("Failed to fetch Solana Devnet balance:", balErr);
            }

            // Initialize custom SVM signer that deserializes @solana/kit v2 Transactions for Phantom signing
            const phantomSigner = {
                address: pubKey as Address,
                async signTransactions(transactions: Parameters<ClientSvmSigner["signTransactions"]>[0]) {
                    logAction("Phantom: Requested transaction signature...");
                    const signed = await Promise.all(transactions.map(async (tx) => {
                        const base64Wire = getBase64EncodedWireTransaction(tx);
                        const versionedTx = VersionedTransaction.deserialize(
                            Uint8Array.from(atob(base64Wire), c => c.charCodeAt(0))
                        );
                        const signedVersionedTx = await provider.signTransaction(versionedTx);
                        const signatureBytes = signedVersionedTx.signatures[0];
                        if (signatureBytes) {
                            (tx as unknown as { signatures: Record<string, Uint8Array> }).signatures[pubKey] = signatureBytes;
                        }
                        return tx;
                    }));
                    return signed;
                }
            };

            const signer = toClientSvmSigner(phantomSigner);
            setSvmSigner(signer);
            logAction("x402 SVM client signer successfully initialized.");
        } catch (err: unknown) {
            logAction(`Phantom Error: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setIsLoading(false);
        }
    };


// Step 7: Use Vaulta Local Derived Accounts instead of Extensions (Alternative fallback)
const useLocalEvmSigner = () => {
    if (!localEvmAccount) return;
    setIsLoading(true);
    try {
        const address = localEvmAccount.address;
        setMetaMaskAddress(address);
        setUsingLocalEvm(true);
        logAction(`Using Vaulta Local EVM Developer Account: ${address}`);

        const publicClient = createPublicClient({
            chain: baseSepolia,
            transport: http()
        });

        // Create private-key based signer using viem utilities
        const privateKey = localEvmAccount.privateKey;
        const customSigner = {
            address: address as `0x${string}`,
            // Type typedData parameters based on ClientEvmSigner to resolve eslint any error
            async signTypedData(typedData: Parameters<ClientEvmSigner["signTypedData"]>[0]) {
                logAction("Local EVM Signer: Signing payload with private key...");
                // Implement signing logic using the imported ethers instance
                const wallet = new ethers.Wallet(privateKey);
                return await wallet.signTypedData(
                    typedData.domain,
                    typedData.types,
                    typedData.message
                ) as `0x${string}`;
            }
        };
        const signer = toClientEvmSigner(customSigner, publicClient);
        setEvmSigner(signer);
        logAction("x402 Local EVM client signer initialized.");
    } catch (err: unknown) {
        logAction(`Local EVM Signer Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        setIsLoading(false);
    }
};

const useLocalSolSigner = async () => {
    if (!localSolAccount) return;
    setIsLoading(true);
    try {
        const address = localSolAccount.address;
        setPhantomAddress(address);
        setUsingLocalSol(true);
        logAction(`Using Vaulta Local Solana Developer Account: ${address}`);

        // Decode the base64 secret key
        const secretKeyBytes = Uint8Array.from(atob(localSolAccount.privateKey), c => c.charCodeAt(0));
        const keypairSigner = await createKeyPairSignerFromBytes(secretKeyBytes);

        const signer = toClientSvmSigner(keypairSigner);
        setSvmSigner(signer);
        logAction("x402 Local SVM client signer initialized.");
    } catch (err: unknown) {
        logAction(`Local SVM Signer Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        setIsLoading(false);
    }
};

// Step 8: Build the dynamic x402-enabled fetch client
const fetchWithPayment = useMemo(() => {
    const client = new x402Client();
    if (evmSigner) {
        client.register("eip155:*", new ExactEvmScheme(evmSigner));
    }
    if (svmSigner) {
        client.register("solana:*", new ExactSvmScheme(svmSigner));
    }
    // Return wrapped fetch that intercepts 402 Payment Required and executes schemes
    return wrapFetchWithPayment(fetch, client);
}, [evmSigner, svmSigner]);

// Step 9: Make payment requests
const callEndpoint = async (endpoint: string, name: string) => {
    if (!evmSigner && !svmSigner) {
        alert("Please connect at least one wallet (MetaMask or Phantom) before executing paywalled requests!");
        return;
    }

    setIsLoading(true);
    setConsoleOutput(null);
    logAction(`Sending pay-per-use request to /${name} ...`);

    try {
        // Call the wrapped fetch. 
        // If the server returns a 402, wrapFetchWithPayment catches it,
        // requests the wallet signature, settles it on-chain via the facilitator,
        // and retries the HTTP request automatically!
        const res = await fetchWithPayment(`http://localhost:3001/${endpoint}`);

        if (res.ok) {
            const data = await res.json();
            setConsoleOutput(data);
            logAction(`Request Successful! Access to /${name} granted by x402 protocol.`);
        } else {
            const text = await res.text();
            logAction(`Request Failed: Server returned status ${res.status}. ${text}`);
            setConsoleOutput({ error: `HTTP ${res.status}`, message: text });
        }
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logAction(`Handshake / Payment Failure: ${errorMsg}`);
        setConsoleOutput({ error: "Exception caught", message: errorMsg });
    } finally {
        setIsLoading(false);
    }
};

return (
    <div className="flex flex-col min-h-screen bg-slate-950 text-slate-100 font-sans">
        <Header />
        <main className="flex-1 mx-auto max-w-6xl w-full px-4 py-8 space-y-8">

            {/* Intro Title Banner */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center p-6 bg-gradient-to-r from-violet-900/40 to-sky-900/40 rounded-2xl border border-violet-500/20 backdrop-blur-md">
                <div className="space-y-1">
                    <div className="flex items-center gap-2">
                        <Badge className="bg-violet-500/10 text-violet-300 border-violet-500/20">Protocol SDK v2</Badge>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Devnet / Sepolia Env</span>
                    </div>
                    <h1 className="text-2xl font-bold tracking-tight text-foreground">x402 Payment Portal</h1>
                    <p className="text-sm text-slate-400">Gate APIs behind instant machine-to-machine crypto micropayments using standard HTTP 402.</p>
                </div>
                <div className="mt-4 md:mt-0 flex gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="gap-2 text-slate-400 hover:text-slate-200"
                        onClick={() => { setLogs([]); setConsoleOutput(null); }}
                    >
                        <RefreshCw className="h-3.5 w-3.5" /> Clear Console
                    </Button>
                </div>
            </div>

            {/* Main Dashboard Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Column 1: Wallet Connection Box */}
                <div className="lg:col-span-1 space-y-6">
                    <Card className="border-slate-800 bg-slate-900/60 shadow-xl backdrop-blur-sm">
                        <CardHeader className="pb-3 border-b border-slate-800/80">
                            <CardTitle className="text-base flex items-center gap-2">
                                <Wallet className="h-4.5 w-4.5 text-primary" /> Wallet Management
                            </CardTitle>
                            <CardDescription>Connect web extension wallets to provide payment signatures.</CardDescription>
                        </CardHeader>
                        <CardContent className="pt-5 space-y-5">

                            {/* EVM MetaMask */}
                            <div className="space-y-2.5">
                                <div className="flex justify-between items-center text-xs">
                                    <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                                        <span className="h-2 w-2 rounded-full bg-orange-500"></span> MetaMask (EVM)
                                    </span>
                                    {metaMaskAddress ? (
                                        <Badge variant="default" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                                            {usingLocalEvm ? "Vaulta Local" : "MetaMask Active"}
                                        </Badge>
                                    ) : (
                                        <Badge variant="secondary" className="bg-slate-800 text-slate-400 text-[10px]">Disconnected</Badge>
                                    )}
                                </div>

                                {metaMaskAddress ? (
                                    <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs space-y-1">
                                        <p className="text-slate-400 truncate">Address: <span className="font-mono text-slate-200">{metaMaskAddress}</span></p>
                                        <p className="text-slate-400">Balance: <span className="font-mono text-violet-400">{ethBalance} Sepolia ETH</span></p>
                                    </div>
                                ) : (
                                    <Button className="w-full text-xs font-semibold bg-violet-600 hover:bg-violet-700 text-white" size="sm" onClick={connectMetaMask}>
                                        Connect MetaMask Wallet
                                    </Button>
                                )}
                            </div>

                            {/* SVM Phantom */}
                            <div className="space-y-2.5">
                                <div className="flex justify-between items-center text-xs mt-2">
                                    <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                                        <span className="h-2 w-2 rounded-full bg-purple-500"></span> Phantom (Solana)
                                    </span>
                                    {phantomAddress ? (
                                        <Badge variant="default" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                                            {usingLocalSol ? "Vaulta Local" : "Phantom Active"}
                                        </Badge>
                                    ) : (
                                        <Badge variant="secondary" className="bg-slate-800 text-slate-400 text-[10px]">Disconnected</Badge>
                                    )}
                                </div>

                                {phantomAddress ? (
                                    <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs space-y-1">
                                        <p className="text-slate-400 truncate">Address: <span className="font-mono text-slate-200">{phantomAddress}</span></p>
                                        <p className="text-slate-400">Balance: <span className="font-mono text-sky-400">{solBalance} Devnet SOL</span></p>
                                    </div>
                                ) : (
                                    <Button className="w-full text-xs font-semibold bg-sky-600 hover:bg-sky-700 text-white" size="sm" onClick={connectPhantom}>
                                        Connect Phantom Wallet
                                    </Button>
                                )}
                            </div>

                            {/* local developer accounts options (for ease of testing) */}
                            {(localEvmAccount || localSolAccount) && (
                                <div className="pt-4 border-t border-slate-800/80 space-y-3">
                                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Local Vaulta Account Fallback</p>
                                    <div className="grid grid-cols-2 gap-2">
                                        {localEvmAccount && (
                                            <Button variant="outline" size="sm" className="h-8 text-[10px] border-violet-500/30 hover:bg-violet-500/10" onClick={useLocalEvmSigner}>
                                                Use Local EVM
                                            </Button>
                                        )}
                                        {localSolAccount && (
                                            <Button variant="outline" size="sm" className="h-8 text-[10px] border-sky-500/30 hover:bg-sky-500/10" onClick={useLocalSolSigner}>
                                                Use Local SVM
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            )}

                        </CardContent>
                    </Card>
                </div>

                {/* Column 2: Available Paywalled Services */}
                <div className="lg:col-span-2 space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                        {/* Card A: Premium Data Gated API */}
                        <Card className="border-slate-800 bg-slate-900/60 shadow-xl backdrop-blur-sm hover:border-violet-500/30 transition-all">
                            <CardHeader className="pb-3">
                                <div className="flex justify-between items-start">
                                    <Badge className="bg-violet-500/15 text-violet-400 border-violet-500/30">Gated Service</Badge>
                                    <div className="text-right">
                                        <span className="text-xs text-muted-foreground">Price</span>
                                        <p className="text-sm font-bold text-violet-400">$0.10 USDC</p>
                                    </div>
                                </div>
                                <CardTitle className="text-base mt-2 flex items-center gap-2">
                                    <Cpu className="h-4.5 w-4.5 text-violet-400" /> Premium Data Dashboard
                                </CardTitle>
                                <CardDescription>Fetches the protected server-side wallet telemetry statistics.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-400">
                                    GET http://localhost:3001/premium-data
                                </div>
                                <Button
                                    className="w-full gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white font-semibold shadow-md"
                                    disabled={isLoading}
                                    onClick={() => callEndpoint("premium-data", "premium-data")}
                                >
                                    {isLoading ? "Executing Paywall Flow..." : "Access Telemetry Dashboard"} <ArrowRight className="h-4 w-4" />
                                </Button>
                            </CardContent>
                        </Card>

                        {/* Card B: Dummy Paid Service Gated API */}
                        <Card className="border-slate-800 bg-slate-900/60 shadow-xl backdrop-blur-sm hover:border-sky-500/30 transition-all">
                            <CardHeader className="pb-3">
                                <div className="flex justify-between items-start">
                                    <Badge className="bg-sky-500/15 text-sky-400 border-sky-500/30">Mock Service</Badge>
                                    <div className="text-right">
                                        <span className="text-xs text-muted-foreground">Price</span>
                                        <p className="text-sm font-bold text-sky-400">$0.05 USDC</p>
                                    </div>
                                </div>
                                <CardTitle className="text-base mt-2 flex items-center gap-2">
                                    <ShieldCheck className="h-4.5 w-4.5 text-sky-400" /> Dummy Paid Service
                                </CardTitle>
                                <CardDescription>Executes a mock paid processing workflow using the x402 protocol.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-400">
                                    GET http://localhost:3001/dummy-paid-service
                                </div>
                                <Button
                                    className="w-full gap-2 bg-gradient-to-r from-sky-600 to-cyan-600 hover:from-sky-700 hover:to-cyan-700 text-white font-semibold shadow-md"
                                    disabled={isLoading}
                                    onClick={() => callEndpoint("dummy-paid-service", "dummy-paid-service")}
                                >
                                    {isLoading ? "Executing Paywall Flow..." : "Invoke Dummy Service"} <Play className="h-4.5 w-4.5 fill-current" />
                                </Button>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Interactive Console / Outputs */}
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-6">

                        {/* Left part: Action logs */}
                        <div className="md:col-span-2 space-y-2">
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Protocol Handshake Logs</label>
                            <div className="h-60 rounded-xl bg-slate-950 border border-slate-800/80 p-4 font-mono text-[10px] overflow-y-auto space-y-2 flex flex-col-reverse scrollbar-thin">
                                {logs.length > 0 ? (
                                    logs.map((log, i) => (
                                        <div key={i} className="text-slate-400 leading-normal border-b border-slate-900/60 pb-1.5">{log}</div>
                                    ))
                                ) : (
                                    <div className="text-slate-600 italic">Logs will appear here once actions are taken...</div>
                                )}
                            </div>
                        </div>

                        {/* Right part: API Output JSON Console */}
                        <div className="md:col-span-3 space-y-2">
                            <label className="text-[10px] font-bold text-slate-500 tracking-widest uppercase">Target Server Response</label>
                            <div className="h-60 rounded-xl bg-slate-950 border border-slate-800/80 p-4 font-mono text-xs overflow-y-auto">
                                {consoleOutput ? (
                                    <pre className="text-slate-300 leading-relaxed overflow-x-auto whitespace-pre-wrap">
                                        {JSON.stringify(consoleOutput, null, 2)}
                                    </pre>
                                ) : (
                                    <div className="text-slate-600 italic">Wait for payment flow execution to verify output...</div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </main>
        <Footer />
    </div>
);
}

import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, sendAndConfirmRawTransaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58"; // For handling private keys in base58 format
import { API_URLS, parseTokenAccountResp } from '@raydium-io/raydium-sdk-v2'
//import { setWhirlpoolsConfig, swapInstructions } from '@orca-so/whirlpools-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID} from '@solana/spl-token'
import axios from 'axios';
import 'dotenv/config';


// RPC
const connection = new Connection(process.env.RPC1, "confirmed");
//export const connection = new Connection(process.env.RPC2, { wsEndpoint: process.env.WEBSOCKET2 });

// Wallet setup (ensure this is secure)

const privateKeyBytes = new bs58.decode(process.env.PRIVATEKEY); // Replace with your private key

const wallet = Keypair.fromSecretKey(privateKeyBytes);


// Token addresses
const SOL = NATIVE_MINT.toBase58(); // SOL token address


const getBuyTxWithJupiter = async (/*wallet,*/ input ,token, amount, slippage) => {
    try {
        // Fetch the quote response
        const quoteResponse = await (
            await fetch(
                `https://quote-api.jup.ag/v6/quote?inputMint=${input}&outputMint=${token}&amount=${amount}&slippageBps=${slippage}`,
            )
        ).json();

        console.log('quoteResponse: ', quoteResponse);

        // Get the serialized swap transaction
        const { swapTransaction } = await (
            await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 10,
                }),
            })
        ).json();

        // Deserialize the transaction
        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        if (!transaction) {
            throw new Error("Failed to retrieve transaction from Jupiter API.");
        }
        transaction.sign([wallet]);

        const result = await connection.simulateTransaction(transaction);

        if (result.value.err) {
          console.error("Simulation failed jupiter:", result.value.err);
          return false;
        }else{
          
          const signature = await sendAndConfirmRawTransaction(connection, transaction.serialize());

          console.log('Transaction sent by jupiter:', signature);

          return true;
        }
          
 
    } catch (error) {
        console.error('Failed to get buy transaction:', error);
        return false;
    }
};



const swapOnRaydium = async (inputMint, outputMint, amount, slippage) => {
  const txVersion = 'V0'; // 'V0' o 'LEGACY'
  const isV0Tx = txVersion === 'V0';

  const { tokenAccounts } = await fetchTokenAccountData();
  const inputTokenAcc = tokenAccounts.find(a => a.mint.toBase58() === inputMint)?.publicKey;
  const outputTokenAcc = tokenAccounts.find(a => a.mint.toBase58() === outputMint)?.publicKey;



  if (!inputTokenAcc && inputMint !== NATIVE_MINT.toBase58()) {
    console.error('No tienes cuenta de token de entrada');
    return;
  }

  //const { data } = await axios.get(`${API_URLS.BASE_HOST}${API_URLS.PRIORITY_FEE}`);
  const { data: swapResponse } = await axios.get(`${API_URLS.SWAP_HOST}/compute/swap-base-in`, {
    params: { inputMint, outputMint, amount, slippageBps: slippage, txVersion }
  });

  console.log(swapResponse)

  const { data: swapTransactions } = await axios.post(`${API_URLS.SWAP_HOST}/transaction/swap-base-in`, {
    computeUnitPriceMicroLamports: String(10),
    swapResponse,
    txVersion,
    wallet: wallet.publicKey.toBase58(),
    wrapSol: inputMint === NATIVE_MINT.toBase58(),
    unwrapSol: outputMint === NATIVE_MINT.toBase58(),
    inputAccount: inputMint === NATIVE_MINT.toBase58() ? undefined : inputTokenAcc?.toBase58(),
    outputAccount: outputMint === NATIVE_MINT.toBase58() ? undefined : outputTokenAcc?.toBase58()
  });

  const allTxBuf = swapTransactions.data.map(tx => Buffer.from(tx.transaction, 'base64'));
  const allTransactions = allTxBuf.map(txBuf => isV0Tx ? VersionedTransaction.deserialize(txBuf) : Transaction.from(txBuf));

  console.log(`Total ${allTransactions.length} transacciones`, swapTransactions);

  let idx = 0;
  if (!isV0Tx) {
    for (const tx of allTransactions) {

      const simulationResult = await connection.simulateTransaction(tx);
      if (simulationResult.value.err) {
        console.error(`❌ Error en simulación:`, simulationResult.value.err);
        return false; // ❗ Si falla la simulación, no enviamos la transacción
      }else{
        console.log(`${++idx} enviando transacción...`);
        tx.sign(wallet);
        const txId = await sendAndConfirmTransaction(connection, tx, [wallet], { skipPreflight: true });
        console.log(`${idx} transacción confirmada, txId: ${txId}`);
      }
    
    }
  } else {
    for (const tx of allTransactions) {

      const { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash({ commitment: 'finalized' });

      idx++;
      tx.sign([wallet]);

      tx.recentBlockhash = blockhash
      tx.lastValidBlockHeight = lastValidBlockHeight

      // 📌 Simulación usando VersionedTransaction
      const result = await connection.simulateTransaction(tx);

      if (result.value.err) {
        console.error(`❌ Error en simulación raydium:`, result.value.err);
        return false
      }else{

        const txId = await connection.sendTransaction(tx);
        console.log(`${idx} enviando transacción raydium, txId: ${txId}`);
        await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature: txId }, 'confirmed');
        console.log(`${idx} transacción confirmada raydium`);
        return true;
      }
    }
  }
};

const fetchTokenAccountData = async () => {
  const solAccountResp = await connection.getAccountInfo(wallet.publicKey);
  const tokenAccountResp = await connection.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
  const token2022Req = await connection.getTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID });
  
  return parseTokenAccountResp({
    owner: wallet.publicKey,
    solAccountResp,
    tokenAccountResp: {
      context: tokenAccountResp.context,
      value: [...tokenAccountResp.value, ...token2022Req.value],
    },
  });
};
  

export async function compra_automata(type, token, amount, slippage) {
  console.log('Iniciando compra automática...');

  let intentos = 0;
  const maxIntentos = 5; // Limitar intentos para evitar bucles infinitos

  while (intentos < maxIntentos) {
      try {
          let tx;
          if (type.toLowerCase().includes('raydium')) {
              tx = await swapOnRaydium(SOL, token, amount, slippage);
          } else {
              tx = await getBuyTxWithJupiter(SOL, token, amount, slippage);
          }

          if (tx) {
              console.log('Transacción completada: ', tx);
              return tx; // Salimos exitosamente
          }

          console.warn(`Intento ${intentos + 1} fallido, reintentando...`);
      } catch (error) {
          console.error("Error en la compra, reintentando...", error);
      }

      intentos++;
      await esperar(1000);
  }

  console.error("No se pudo completar la compra después de varios intentos.");
  return null; // Devuelve `null` si no se pudo completar la compra
}


export async function venta_automata(type, token, slippage, montos) {
  console.log('Iniciando venta automática...');

  while (true) {
      try {
          let intentos = 0;
          let final_mount;
          
          while (intentos < 5) {
              final_mount = await getSpecificTokenBalance(new PublicKey(token));
              if (final_mount !== -1) break;
              console.log(`Error al obtener balance, reintentando... (${intentos + 1}/5)`);
              await esperar(1000);
              intentos++;
          }

          if (final_mount === -1) {
              console.error("No se pudo obtener el balance después de varios intentos.");
              return;
          }

          if (final_mount == 0 && !montos) {
              console.log('Balance agotado, finalizando...');
              return;
          }

          console.log('Monto inicial: ', final_mount);

          let tx;
          try {
              if (type.toLowerCase().includes('raydium')) {
                  tx = await swapOnRaydium(token, SOL, final_mount, slippage);
              } else {
                  tx = await getBuyTxWithJupiter(token, SOL, final_mount, slippage);
              }
          } catch (error) {
              console.error("Error en la transacción:", error);
              continue;
          }

          console.log('Transacción completada: ', tx);
          await esperar(1000);

          if (!tx) continue;

          montos -= final_mount;
          if (montos <= 0) {
              console.log("Se vendieron todos los tokens.");
              return;
          }

      } catch (error) {
          console.error('Error en la transacción, reintentando...', error);
      }

      console.log('Esperando antes del siguiente intento...');
      await esperar(1000);
  }
}




async function getSpecificTokenBalance(mintAddress) {
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") // Programa SPL-Token
  });

  const tokenAccount = accounts.value.find(accountInfo => 
      accountInfo.account.data.parsed.info.mint === mintAddress.toBase58()
  );

  if (tokenAccount) {
      const tokenData = tokenAccount.account.data.parsed.info;
      console.log(`Balance del token (${mintAddress.toBase58()}): ${tokenData.tokenAmount.amount}`);
      return tokenData.tokenAmount.amount;
  
  } else {
      console.log("No tienes saldo de este token.");
      return -1;
  }

  
}


/**
 * Swap tokens using Orca Whirlpools.

async function swapOnOrca(amount, slippageTolerance = 100) {
    try {
        // Configure Whirlpools SDK
        await setWhirlpoolsConfig('mainnet-beta');

        // Convert amount to lamports if the token is SOL
        const inputAmount = amount * LAMPORTS_PER_SOL;

        // Generate swap instructions
        const { instructions, quote } = await swapInstructions(
            connection,
            {
                inputAmount,
                mint: SOL_MINT,
            },
            ORCA_POOL_ADDRESS,
            slippageTolerance,
            wallet
        );

        console.log("Orca Swap Quote:", quote);

        // Create and send the transaction
        const transaction = new Transaction().add(...instructions);
        const signature = await sendAndConfirmTransaction(connection, transaction, [wallet]);
        console.log(`Orca Swap Completed: https://solscan.io/tx/${signature}`);
        return signature;
    } catch (error) {
        console.error("Failed to execute Orca swap:", error);
        return null;
    }
}



 */


export function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
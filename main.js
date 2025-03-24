import axios from 'axios';
import * as aq from "arquero";
import * as readline from 'readline';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';

const SOL = NATIVE_MINT.toBase58();
const MONTO = 0.0001 * LAMPORTS_PER_SOL;
const SLIPPAGE = 1 * 100; // 60% de slippage;

async function loadLib() {
    const { compra_automata, venta_automata } = await import('./lib.js');
    return { compra_automata, venta_automata };
}

function recortarCadena(cadena) {
    return cadena.length > 10 ? `${cadena.slice(0, 5)}...${cadena.slice(-5)}` : cadena;
}

async function obtenerMercados(mint) {
    const apiUrl = `https://production-api.mobula.io/api/1/market/pairs?asset=${mint}&blockchain=solana&limit=100`;
    try {
        const response = await axios.get(apiUrl);
        return response.data.data.pairs.map(market => ({
            address: market.address,
            marketType: market.type,
            mintA: market.token0.symbol,
            mintB: market.token1.symbol,
            Price: market.price,
            liquidity: market.liquidity
        }));
    } catch (error) {
        console.error('Error al obtener mercados:', error);
        return [];
    }
}

function analizarMercados(mercados) {
    let df = aq.from(mercados).filter(d => d.liquidity > 1000).orderby("Price");
    df.print(100);

    let maxPriceMarket = df.slice(-1);
    let minPriceMarket = df.slice(0, 1);
    
    console.log("\n🔺 Mercado con Mayor Precio:");
    maxPriceMarket.print();

    console.log("\n🔻 Mercado con Menor Precio:");
    minPriceMarket.print();
    
    return { minPriceMarket, maxPriceMarket };
}

async function obtenerRutasJupiter(inmint, outmint, amount) {
    const route_compra = `https://quote-api.jup.ag/v6/quote?inputMint=${inmint}&outputMint=${outmint}&amount=${amount}&slippageBps=2&restrictIntermediateTokens=true&platformFeeBps=1`;
    let ruta_compra = await axios.get(route_compra).catch(() => null);
    if (!ruta_compra) return { ruta_compra: null, ruta_venta: null };

    const route_venta = `https://quote-api.jup.ag/v6/quote?inputMint=${outmint}&outputMint=${inmint}&amount=${ruta_compra.data.outAmount}&slippageBps=2&restrictIntermediateTokens=true&platformFeeBps=1`;
    let ruta_venta = await axios.get(route_venta).catch(() => null);
    return { ruta_compra, ruta_venta };
}

function calcularRuta(camino) {
    return camino.map(route => route.swapInfo);
}

async function ejecutarCompra(mint, ruta_compra, minPriceMarket) {
    const { compra_automata } = await loadLib();
    console.log("Iniciando compra automática...");
    let label = ruta_compra ? ruta_compra.data.routePlan[0].swapInfo.label : minPriceMarket.get("marketType", 0);
    return await compra_automata(label, mint, MONTO, SLIPPAGE);
}

async function ejecutarVenta(mint, ruta_venta, maxPriceMarket, aux) {
    const { venta_automata } = await loadLib();
    console.log("Iniciando venta automática...");
    let label = ruta_venta ? ruta_venta.data.routePlan[0].swapInfo.label : maxPriceMarket.get("marketType", 0);
    return await venta_automata(label, mint, SLIPPAGE, aux);
}

async function iniciar() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Ingrese mint: ', async (mint) => {
        console.log(`Buscando mercados para el mint: ${mint}`);
        let mercados = await obtenerMercados(mint);
        let { minPriceMarket, maxPriceMarket } = analizarMercados(mercados);
        let { ruta_compra, ruta_venta } = await obtenerRutasJupiter(SOL, mint, MONTO);
        
        if (ruta_compra) {
            console.log("\n🚀 Ruta Recomendada para compra del token:");
            aq.from(calcularRuta(ruta_compra.data.routePlan)).select("ammKey", "label", "inputMint", "outputMint").print(100);
        }
        
        if (ruta_venta) {
            console.log("\n🚀 Ruta Recomendada para venta del token:");
            aq.from(calcularRuta(ruta_venta.data.routePlan)).select("ammKey", "label", "inputMint", "outputMint").print(100);
        }
        
        rl.question('Desea continuar con compra automática recomendada (S:SI, N:NO): ', async (resp) => {
            if (resp.toLowerCase() === 's') {
                var aux = await ejecutarCompra(mint, ruta_compra, minPriceMarket);
            } else {
                console.log("Compra cancelada");
            }
            
            rl.question('Desea continuar con venta automática recomendada (S:SI, N:NO): ', async (resp) => {
                if (resp.toLowerCase() === 's') {
                    await ejecutarVenta(mint, ruta_venta, maxPriceMarket, aux);
                } else {
                    console.log("Venta cancelada");
                }
                rl.close();
            });
        });
    });
}

iniciar();

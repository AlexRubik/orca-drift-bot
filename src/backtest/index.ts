import { getHourlyPrices } from "./backtestUtils";

// main func
async function main() {
    const prices = await getHourlyPrices(365, "solana");
    console.log(prices);
}

main();
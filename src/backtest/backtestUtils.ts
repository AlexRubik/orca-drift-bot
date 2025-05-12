/**
 * Fetches hourly price data for a cryptocurrency from CoinGecko API
 * @param numDays Number of days of historical data to fetch (default: 365)
 * @param coinId Cryptocurrency ID in CoinGecko (default: "solana")
 * @returns Array of price data points [timestamp, price]
 */
export async function getHourlyPrices(numDays: number = 365, coinId: string = "solana"): Promise<[number, number][]> {
  const fromTimestamp = Math.floor(Date.now() / 1000) - numDays * 24 * 60 * 60;
  const toTimestamp = Math.floor(Date.now() / 1000);
  
  const url = new URL(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart/range`);
  url.searchParams.append("vs_currency", "usd");
  url.searchParams.append("from", fromTimestamp.toString());
  url.searchParams.append("to", toTimestamp.toString());

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    const data = await response.json();
    const hourlyPrices = data.prices as [number, number][];
    console.log(`Retrieved ${hourlyPrices.length} hourly price points`);
    return hourlyPrices;
  } catch (error) {
    console.error('Error fetching price data:', error);
    throw error;
  }
}

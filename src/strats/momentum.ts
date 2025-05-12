import { getUsdPriceFromJup } from "../jup";
import { getPythPrice } from "../pyth";

export async function checkValidMomentumForPosition(
    token: 'solana' | 'bitcoin',
    basicPriceDataArray: BasicPriceData[] = [],
    positiveMomentumThreshold10h: number = 0.02,
    negativeMomentumThreshold10h: number = -0.03,
    positiveMomentumThreshold24h: number = 0.04,
    negativeMomentumThreshold24h: number = -0.04
) {

    // if basicPriceDataArray is empty, fetch the data from CoinGecko
    if (basicPriceDataArray.length === 0 || basicPriceDataArray.length < 23) {
        console.log('Fetching inital price data from CoinGecko');
        const hourlyData = await getCoinHourly(2, token);
        basicPriceDataArray = hourlyData.basicPriceDataArray;
        // log number of price data points
        console.log(`Number of initial hourly price data points: ${basicPriceDataArray.length}`);
    }

    // if the last element in basicPriceDataArray is not in the current hour,
    // grab price from pyth
    const lastElement = basicPriceDataArray[basicPriceDataArray.length - 1];
    const lastElementDate = new Date(lastElement.unixTimestamp);
    const lastElementHour = lastElementDate.getHours();
    const currentDate = new Date();
    const currentHour = currentDate.getHours();

    if (lastElementHour !== currentHour) {
        console.log('Adding new price data point from Pyth because we do not have one in the current hour');
        const pythPrice = await getPythPrice(); // default is SOL
        basicPriceDataArray.push({
            unixTimestamp: currentDate.getTime(),
            price: pythPrice
        });
    }

    // if the basicPriceDataArray is > 30 elements, remove the first element
    if (basicPriceDataArray.length > 30) {
        basicPriceDataArray.shift();
    }

    const momentumMetrics = getMomentumMetrics(basicPriceDataArray);

    const isValid10h = momentumMetrics.momentum10h < positiveMomentumThreshold10h && 
    momentumMetrics.momentum10h > negativeMomentumThreshold10h;

    const isValid24h = momentumMetrics.momentum24h < positiveMomentumThreshold24h && 
    momentumMetrics.momentum24h > negativeMomentumThreshold24h;

    return {
        isValid: isValid10h && isValid24h,
        currentMomentum10h: momentumMetrics.momentum10h,
        currentMomentum24h: momentumMetrics.momentum24h,
        basicPriceDataArray: basicPriceDataArray
    }

}

interface CoinMarketChartResponse {
    prices: [number, number][];
    market_caps?: [number, number][];
    total_volumes?: [number, number][];
  }
  
  /**
   * Fetches historical price data for a cryptocurrency within a specified time range
   * @param pastNumberOfDays The number of days to fetch data for. Must be > 1
   * @param coinId The ID of the coin in CoinGecko
   */
  export async function getCoinHourly(
    pastNumberOfDays: number = 2,
    coinId: string = "solana"
  ): Promise<{
    dataArray: any[];
    basicPriceDataArray: BasicPriceData[];
  }> {

    if (pastNumberOfDays < 1) {
        console.warn('pastNumberOfDays must be greater than 0, using default of 2');
        pastNumberOfDays = 2;
    }

    const now = Math.floor(Date.now() / 1000); // current unix timestamp in seconds
    const fromTimestamp = now - (24 * 60 * 60 * pastNumberOfDays); // one day ago in seconds
    const toTimestamp = now; // current unix timestamp in seconds
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart/range`;

    
    const params = new URLSearchParams({
      vs_currency: "usd",
      from: fromTimestamp.toString(),
      to: toTimestamp.toString()
    });
    
    const response = await fetch(`${url}?${params}`);

    const data: CoinMarketChartResponse = await response.json();

    console.log('Full URL:', `${url}?${params}`);
    
    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
    }

    // if each field in the response has the same length, create an array ofobject with the prices, market_caps, and total_volumes
    // for each timestamp

    const prices = data.prices; // first element is the timestamp, second is the price
    const marketCaps = data.market_caps; // first element is the timestamp, second is the market cap
    const totalVolumes = data.total_volumes; // first element is the timestamp, second is the total volume

    if (prices.length !== marketCaps?.length || prices.length !== totalVolumes?.length) {
        throw new Error('Data length mismatch');
    }

    const dataArray = [];
    const basicPriceDataArray: BasicPriceData[] = [];

    for (let i = 0; i < prices.length; i++) {
        // Get the date object from the timestamp
        const date = new Date(prices[i][0]);
        

            dataArray.push({
                unixTimestamp: prices[i][0],
                date: date.toISOString(),
                price: prices[i][1],
                marketCap: marketCaps?.[i]?.[1],
                totalVolume: totalVolumes?.[i]?.[1]
            });

            basicPriceDataArray.push({
                unixTimestamp: prices[i][0],
                price: prices[i][1]
            });
        
    }

    

    
    return {
        dataArray,
        basicPriceDataArray
    };
  }

  export interface BasicPriceData {
    unixTimestamp: number;
    price: number;
  }

  export interface MomentumMetrics {
    momentum10h: number;
    momentum24h: number;
  }

  /**
   * Calculates momentum metrics for the most recent data point
   * @param data Array of price data points (at least 24 elements)
   * @returns Promise with momentum metrics for 10h and 24h lookback periods
   */
  export function getMomentumMetrics(data: BasicPriceData[]): MomentumMetrics {
    // Ensure we have enough data
    if (data.length < 24) {
      throw new Error('Insufficient data: at least 24 data points required');
    }
    
    // Sort data by timestamp in ascending order (oldest first)
    const sortedData = [...data].sort((a, b) => a.unixTimestamp - b.unixTimestamp);
    
    // Get the most recent price (last element)
    const currentIndex = sortedData.length - 1;
    const currentPrice = sortedData[currentIndex].price;
    
    // Calculate 10-hour momentum
    const index10h = currentIndex - 10;
    const price10h = index10h >= 0 ? sortedData[index10h].price : sortedData[0].price;
    const momentum10h = (currentPrice / price10h) - 1;
    
    // Calculate 24-hour momentum
    const index24h = currentIndex - 24;
    const price24h = index24h >= 0 ? sortedData[index24h].price : sortedData[0].price;
    const momentum24h = (currentPrice / price24h) - 1;
    
    return {
      momentum10h,
      momentum24h
    };
  }


  
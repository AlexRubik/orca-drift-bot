import { SOL_MINT } from "../constants";
import { deposit, getPositionDetails, getUser, initUserAndDeposit, placeAndTakePerpOrder } from "./drift-worker-interface";
import { PlaceAndTakeOrderSuccessCondition, PositionDirection } from "./drift-worker-types";

// orderMarketIndex 
const orderMarketIndex = {
    SOL: 0

}

// handle deposit

export async function handleUserAndDeposit(
    subAccountId: number | undefined = undefined,
    usdcForCollateral: number,
    maxAttempts: number = 6,
    retryDelaySeconds: number = 1,
    
) {
    console.log("Starting handleUserAndDeposit");
    
    let attempts = 0;
    while (attempts < maxAttempts) {
        try {
            console.log(`Attempt ${attempts + 1}/${maxAttempts} to handle user and deposit`);
            
            // Try to get user first
            try {
                // getUser and if no error then deposit appropriate amount of usdc for collateral
                let user = await getUser(subAccountId);
                
                let newUsdcDriftBalance: number | undefined = 0;
        
                // see if user has enough usdc for collateral and deposit the appropriate amount if not
                const initialDriftUsdcBalance = user.data?.user.userAccountBalanceUsdc;

                console.log("initialDriftUsdcBalance: ", initialDriftUsdcBalance);
                console.log("param usdcForCollateral: ", usdcForCollateral);
                if (initialDriftUsdcBalance && initialDriftUsdcBalance < usdcForCollateral) {
                    const depositAmount = usdcForCollateral - initialDriftUsdcBalance;

                    // if depositAmount is less than 0.05 then return the bal and subAccountId
                    if (depositAmount < 0.05) {
                        console.log("Deposit amount is less than 0.05, returning initial balance and subAccountId");
                        return {
                            newBalance: initialDriftUsdcBalance,
                            subAccountId: subAccountId
                        };
                    }

                    console.log("depositAmount: ", depositAmount);
                    await deposit(
                        0, 
                        Number(depositAmount.toFixed(3)),
                        subAccountId
                    ); // market index 0 is usdc for deposit
                    user = await getUser(subAccountId);
                    newUsdcDriftBalance = user.data?.user.userAccountBalanceUsdc;
                }

                // throw if new bal is zero and initial bal was zero
                if (newUsdcDriftBalance === 0 && initialDriftUsdcBalance === 0) {
                    throw new Error("New usdc drift balance is zero");
                }
                
                console.log("User deposit handling completed successfully");
                return {
                    newBalance: newUsdcDriftBalance && newUsdcDriftBalance > 0 ? newUsdcDriftBalance : initialDriftUsdcBalance,
                    subAccountId: subAccountId
                };
                
            } catch (userError: any) {
                // Check if the error is about no user
                if (userError.message && userError.message.includes("has no user")) {
                    console.log("No user account found. Initializing user account and depositing...");
                    
                    // Initialize user account and deposit in one operation
                    const initResult = await initUserAndDeposit(
                        usdcForCollateral,  // amount to deposit
                        0,                  // marketIndex (USDC)
                        subAccountId,       // subAccountId
                        "LP-Bot",           // name
                        undefined,          // fromSubAccountId
                        undefined,          // donateAmount
                        undefined,          // customMaxMarginRatio
                        undefined,          // poolId
                        attempts >= Math.floor(maxAttempts / 2) // useNextSubAccount
                    );
                    
                    if (initResult.type === 'SUCCESS') {
                        console.log("Successfully initialized user account and deposited funds");
                        
                        // Get updated balance
                        const user = await getUser(initResult.data?.subAccountId);
                        const newBalance = user.data?.user.userAccountBalanceUsdc;
                        
                        return {
                            newBalance: newBalance || usdcForCollateral,
                            subAccountId: initResult.data?.subAccountId
                        };
                    } else {
                        throw new Error("Failed to initialize user account and deposit");
                    }
                } else {
                    // If it's a different error, rethrow it
                    throw userError;
                }
            }
            
        } catch (error) {
            attempts++;
            console.error(`Error in handleUserAndDeposit (attempt ${attempts}/${maxAttempts}):`, error);
            
            if (attempts >= maxAttempts) {
                console.error("Max attempts reached for handling user and deposit, giving up");
                throw error;
            }
            
            console.log(`Waiting ${retryDelaySeconds} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, Math.floor(retryDelaySeconds * 1000)));
        }
    }
    
    throw new Error("Max attempts reached for handling user and deposit, giving up");
}

export async function manageShortPositions(
    subAccountId: number | undefined = undefined,
    tokenAMint: string,
    tokenBMint: string,
    tokenADecimals: number,
    tokenBDecimals: number,
    tokenAEstAmountNormalized: number,
    tokenBEstAmountNormalized: number,
    maxAttempts: number = 12,
    retryDelaySeconds: number = 1
) {
    console.log("Starting manageShortPositions with subAccountId: ", subAccountId);
    
    let attempts = 0;
    while (attempts < maxAttempts) {
        try {
            console.log(`Attempt ${attempts + 1}/${maxAttempts} to manage short positions`);
        

            // if user has enough usdc for collateral then open short position
            const manageShort = await placeAndTakePerpOrder(
                PositionDirection.SHORT,
                orderMarketIndex.SOL,
                tokenAEstAmountNormalized,
                PlaceAndTakeOrderSuccessCondition.FullFill,
                tokenADecimals,
                subAccountId
            );
            
            return manageShort;
        } catch (error) {
            attempts++;
            console.error(`Error in manageShortPositions (attempt ${attempts}/${maxAttempts}):`, error);
            
            if (attempts >= maxAttempts) {
                console.error("Max attempts reached for managing short, giving up");
                return null;
            }
            
            console.log(`Waiting ${retryDelaySeconds} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, Math.floor(retryDelaySeconds * 1000)));
        }
    }
}

export async function closeShort(
    subAccountId: number,
    tokenAMint: string,
    tokenADecimals: number,
    maxAttempts: number = 20,
    retryDelaySeconds: number = 1.2
) {
    let attempts = 0;
    while (attempts < maxAttempts) {
        try {
            console.log(`Attempt ${attempts + 1}/${maxAttempts} to close short position`);
            
            // if tokenAMint is SOL then orderMarketIndex is SOL
            const currentOrderMarketIndex = tokenAMint === SOL_MINT ? orderMarketIndex.SOL : orderMarketIndex.SOL; // TODO: change this to the correct market index

            // get position details
            const posDetails = await getPositionDetails(
                currentOrderMarketIndex,
                tokenADecimals
            );
            
            if (!posDetails.data) {
                console.log("No position details found, nothing to close");
                return null;
            }
            
            const closeShortOutput = await placeAndTakePerpOrder(
                PositionDirection.LONG,
                currentOrderMarketIndex,
                posDetails.data.baseAssetAmountNormalized,
                PlaceAndTakeOrderSuccessCondition.FullFill,
                tokenADecimals,
                subAccountId
            );
            
            return closeShortOutput;
        } catch (error) {
            attempts++;
            console.error(`Error in closeShort (attempt ${attempts}/${maxAttempts}):`, error);
            
            if (attempts >= maxAttempts) {
                console.error("Max attempts reached for closing short, giving up");
                throw error;
            }

            // delay 10 seconds if attempt is > 12
            if (attempts > 12) {
                retryDelaySeconds = 10;
            }
            
            console.log(`Waiting ${retryDelaySeconds} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, Math.floor(retryDelaySeconds * 1000)));
        }
    }
}

export function calculateRequiredCollateral(
    positionSizeUSD: number,
    liqPricePercent: number
  ): number {
    // For both longs and shorts, collateral = position size * (liqPricePercent/100)
    return positionSizeUSD * (liqPricePercent/100);
  }
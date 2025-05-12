import time
import requests
import json
from typing import List

def get_market_tokens():
    url = "https://pro.circular.bot/market/tokens"
    
    headers = {
        "Content-Type": "application/json",
        "x-api-key": "6c214028-9066-42b9-96f4-d3ef91c87333"
    }
    
    params = {
        "maxTokensList": 50,
        "maxTimeRange": 900,
        "excludeTokens[]": [
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
            "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            "So11111111111111111111111111111111111111112"
        ],
        "provider": "NO_PROVIDER",
        "token": "So11111111111111111111111111111111111111112"
    }
    
    try:
        response = requests.get(
            url, 
            headers=headers, 
            params=params,
            timeout=30
        )
        print(f"Request URL: {response.url}")
        print(f"Status Code: {response.status_code}")
        print(f"Response Headers: {response.headers}")
        
        try:
            print("\nResponse Body:")
            print(json.dumps(response.json(), indent=2))
            print("Returning the array of token mints")
            
            # the response is an array of token mints as strings
            # return the array
            return response.json()
            
            
        except json.JSONDecodeError:
            print("\nRaw Response Text (not valid JSON):")
            print(response.text)
            
        response.raise_for_status()
        
    except requests.exceptions.RequestException as e:
        print(f"Error making request: {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"\nError Response Status: {e.response.status_code}")
            print(f"Error Response Headers: {e.response.headers}")
            try:
                print("\nError Response Body:")
                print(json.dumps(e.response.json(), indent=2))
            except json.JSONDecodeError:
                print("\nRaw Error Response Text:")
                print(e.response.text)

def get_filtered_market_cache(api_key: str, tokens: List[str], only_jup: bool = False) -> dict:
    url = "https://pro.circular.bot/market/cache"
    
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key
    }
    
    params = {
        "onlyjup": only_jup,
        "tokens": ",".join(tokens)
    }
    
    try:
        response = requests.get(
            url, 
            headers=headers, 
            params=params,
            timeout=30
        )
        print(f"Request URL: {response.url}")
        print(f"Status Code: {response.status_code}")
        print(f"Response Headers: {response.headers}")
        
        try:
            print("\nResponse Body:")
            print(json.dumps(response.json(), indent=2))
            print("Returning the market cache")
            return response.json()
        except json.JSONDecodeError:
            print("\nRaw Response Text (not valid JSON):")
            print(response.text)
            
        response.raise_for_status()
        
    except requests.exceptions.RequestException as e:
        print(f"Error making request: {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"\nError Response Status: {e.response.status_code}")
            print(f"Error Response Headers: {e.response.headers}")
            try:
                print("\nError Response Body:")
                print(json.dumps(e.response.json(), indent=2))
            except json.JSONDecodeError:
                print("\nRaw Error Response Text:")
                print(e.response.text)

def post_markets_to_local(markets_array: List[dict]) -> None:
    local_url = "http://localhost:8080/add-market"
    
    print(f"\nPosting {len(markets_array)} markets to {local_url}")
    
    for market in markets_array:
        try:
            response = requests.post(
                local_url,
                json=market,  # Automatically serializes dict to JSON
                headers={"Content-Type": "application/json"},
                timeout=30
            )
            print(f"\nPosting market {market.get('address', 'unknown')}:")
            print(f"Status Code: {response.status_code}")
            
            try:
                print("Response:", json.dumps(response.json(), indent=2))
            except json.JSONDecodeError:
                print("Raw Response:", response.text)
                
            response.raise_for_status()
            
        except requests.exceptions.RequestException as e:
            print(f"Error posting market: {e}")
            if hasattr(e, 'response') and e.response is not None:
                print(f"Error Response Status: {e.response.status_code}")
                try:
                    print("Error Response:", json.dumps(e.response.json(), indent=2))
                except json.JSONDecodeError:
                    print("Raw Error Response:", e.response.text)
            # Continue to next market even if this one failed
            continue

if __name__ == "__main__":
    # First get the market tokens
    tokens = get_market_tokens()
    # wait 2 seconds
    time.sleep(1)
    
    if tokens:
        print("\nNow fetching market cache for returned tokens...")
        # Use the returned tokens for the market cache request
        markets_array = get_filtered_market_cache("6c214028-9066-42b9-96f4-d3ef91c87333", tokens)
        
        if markets_array:
            post_markets_to_local(markets_array)
        else:
            print("No markets data to post")
    else:
        print("Failed to get market tokens, cannot proceed with market cache request")

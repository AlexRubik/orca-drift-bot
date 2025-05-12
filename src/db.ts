import { Pool } from 'pg';
import { Address } from '@solana/web3.js';
import { Strategy } from './constants';
// import env
import dotenv from 'dotenv';
dotenv.config();


// Database connection configuration
export const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT),
});

// Interface matching the database schema
export interface LpPosition {
    id?: number;
    session_id: string;
    position_mint_address: string;
    pool_address: string;
    entry_price: number;
    range_deviation_perc_as_decimal: number;
    starting_usd_value: number;
    starting_token_a_amount: number;
    starting_token_b_amount: number;
    session_start_time: number;
    session_end_time?: number;
    session_start_token_a_balance_usd_value?: number;
    session_start_token_b_balance_usd_value?: number;
    session_end_token_a_balance_usd_value?: number;
    session_end_token_b_balance_usd_value?: number;
    lower_boundary: number;
    upper_boundary: number;
    is_active: boolean;
    closing_usd_value?: number;
    pubkey: string;
    created_at?: Date;
    updated_at?: Date;
    position_start_time: number;
    position_end_time?: number;
    ending_token_a_amount?: number;
    ending_token_b_amount?: number;
    closing_price?: number;
    token_a_mint: string;
    token_b_mint: string;
    strategy: Strategy;
    take_profit_threshold: number;
}
// TODO: create table in db:
export interface PerpPosition {
    id?: number;
    position_mint_address: string; // primary key
    token: 'SOL' | 'BTC' | 'ETH';
    size: number;
    entry_price: number;
    exit_price?: number;
    pnl?: number;
    usdc_collateral_amount: number;
    position_start_time: number; // bigint, unix timestamp
    position_end_time?: number; // bigint, unix timestamp
    drift_usdc_balance_at_start?: number;
    drift_usdc_balance_at_end?: number;
    is_active: boolean;
}

// Add this enum at the top of the file with other types
export enum ActivityFilter {
    ACTIVE_ONLY = 'ACTIVE_ONLY',
    INACTIVE_ONLY = 'INACTIVE_ONLY',
    ALL = 'ALL'
}

// Database helper functions
export const db = {
    // Create new LP position record
    async createPosition(
        position: Omit<LpPosition, 'id' | 'created_at' | 'updated_at'>, 
        isSessionStart: boolean = false
    ): Promise<LpPosition> {
        let sessionStartTime = position.session_start_time;
        let sessionStartTokenABalanceUsdValue = position.session_start_token_a_balance_usd_value;
        let sessionStartTokenBBalanceUsdValue = position.session_start_token_b_balance_usd_value;

        if (!isSessionStart) {
            // Get session values from existing active position
            const activePosition = await this.getActivePositionBySessionId(position.session_id);
            if (activePosition) {
                sessionStartTime = activePosition.session_start_time;
                sessionStartTokenABalanceUsdValue = activePosition.session_start_token_a_balance_usd_value;
                sessionStartTokenBBalanceUsdValue = activePosition.session_start_token_b_balance_usd_value;
            }
        }

        const query = `
            INSERT INTO lp_positions (
                session_id,
                position_mint_address,
                pool_address,
                entry_price,
                range_deviation_perc_as_decimal,
                starting_usd_value,
                starting_token_a_amount,
                starting_token_b_amount,
                session_start_time,
                position_start_time,
                lower_boundary,
                upper_boundary,
                is_active,
                session_start_token_a_balance_usd_value,
                session_start_token_b_balance_usd_value,
                pubkey,
                token_a_mint,
                token_b_mint,
                strategy,
                take_profit_threshold
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, 
                $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19, $20
            )
            RETURNING *
        `;

        const values = [
            position.session_id,
            position.position_mint_address,
            position.pool_address,
            position.entry_price,
            position.range_deviation_perc_as_decimal,
            position.starting_usd_value,
            position.starting_token_a_amount,
            position.starting_token_b_amount,
            sessionStartTime,  // Use session values from first position
            position.position_start_time,
            position.lower_boundary,
            position.upper_boundary,
            position.is_active,
            sessionStartTokenABalanceUsdValue,  // Use session values from first position
            sessionStartTokenBBalanceUsdValue,  // Use session values from first position
            position.pubkey,
            position.token_a_mint,
            position.token_b_mint,
            position.strategy,
            position.take_profit_threshold
        ];

        const result = await pool.query(query, values);
        return result.rows[0];
    },

    // Close an LP position
    async closePosition(
        positionMintAddress: string,
        closingData: {
            position_end_time: number;
            session_end_time?: number;
            closing_usd_value: number;
            ending_token_a_amount: number;
            ending_token_b_amount: number;
            closing_price: number;
            session_end_token_a_balance_usd_value?: number;
            session_end_token_b_balance_usd_value?: number;
        },
        isSessionEnd: boolean = false
    ): Promise<void> {
        const query = `
            UPDATE lp_positions
            SET 
                is_active = false,
                position_end_time = $1,
                ${isSessionEnd ? 'session_end_time = $2,' : ''}
                closing_usd_value = ${isSessionEnd ? '$3' : '$2'},
                ending_token_a_amount = ${isSessionEnd ? '$4' : '$3'},
                ending_token_b_amount = ${isSessionEnd ? '$5' : '$4'},
                closing_price = ${isSessionEnd ? '$6' : '$5'}
                ${isSessionEnd ? ', session_end_token_a_balance_usd_value = $7' : ''}
                ${isSessionEnd ? ', session_end_token_b_balance_usd_value = $8' : ''}
            WHERE position_mint_address = ${isSessionEnd ? '$9' : '$6'}
        `;

        const values = isSessionEnd ? [
            closingData.position_end_time,
            closingData.session_end_time,
            closingData.closing_usd_value,
            closingData.ending_token_a_amount,
            closingData.ending_token_b_amount,
            closingData.closing_price,
            closingData.session_end_token_a_balance_usd_value,
            closingData.session_end_token_b_balance_usd_value,
            positionMintAddress
        ] : [
            closingData.position_end_time,
            closingData.closing_usd_value,
            closingData.ending_token_a_amount,
            closingData.ending_token_b_amount,
            closingData.closing_price,
            positionMintAddress
        ];

        await pool.query(query, values);
    },

    // Get active position by session ID
    async getActivePositionBySessionId(sessionId: string): Promise<LpPosition | null> {
        const query = `
            SELECT * FROM lp_positions
            WHERE session_id = $1 AND is_active = true
            LIMIT 1
        `;

        const result = await pool.query(query, [sessionId]);
        return result.rows[0] || null;
    },

    // Get position by mint address
    async getPositionByMintAddress(positionMintAddress: string): Promise<LpPosition | null> {
        const query = `
            SELECT * FROM lp_positions
            WHERE position_mint_address = $1
            LIMIT 1
        `;

        const result = await pool.query(query, [positionMintAddress]);
        return result.rows[0] || null;
    },

    // Get positions by pubkey with activity filter
    async getPositionsByPubkey(pubkey: string, activityFilter: ActivityFilter = ActivityFilter.ALL): Promise<LpPosition[]> {
        let query = `
            SELECT * FROM lp_positions
            WHERE pubkey = $1
        `;
        
        const queryParams: (string | boolean)[] = [pubkey];

        // Add activity filter
        switch (activityFilter) {
            case ActivityFilter.ACTIVE_ONLY:
                query += ` AND is_active = true`;
                break;
            case ActivityFilter.INACTIVE_ONLY:
                query += ` AND is_active = false`;
                break;
            case ActivityFilter.ALL:
                // No additional filter needed
                break;
        }

        // Order by most recent first
        query += ` ORDER BY created_at DESC`;

        const result = await pool.query(query, queryParams);
        return result.rows;
    },

    // Create new perp position record
    async createPerpPosition(
        perpPosition: Omit<PerpPosition, 'id' | 'created_at' | 'updated_at'>
    ): Promise<PerpPosition> {
        const perpQuery = `
            INSERT INTO perp_positions (
                position_mint_address,
                token,
                size,
                entry_price,
                exit_price,
                pnl,
                usdc_collateral_amount,
                position_start_time,
                position_end_time,
                drift_usdc_balance_at_start,
                drift_usdc_balance_at_end,
                is_active
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
            )
            RETURNING *
        `;

        const perpValues = [
            perpPosition.position_mint_address,
            perpPosition.token,
            perpPosition.size,
            perpPosition.entry_price,
            perpPosition.exit_price,
            perpPosition.pnl,
            perpPosition.usdc_collateral_amount,
            perpPosition.position_start_time,
            perpPosition.position_end_time,
            perpPosition.drift_usdc_balance_at_start,
            perpPosition.drift_usdc_balance_at_end,
            perpPosition.is_active
        ];

        const result = await pool.query(perpQuery, perpValues);
        return result.rows[0];
    },

    // Close a perp position
    async closePerpPosition(
        positionMintAddress: string,
        closingData: {
            position_end_time: number;
            exit_price: number;
            pnl: number;
            drift_usdc_balance_at_end?: number;
        }
    ): Promise<void> {
        const query = `
            UPDATE perp_positions
            SET 
                is_active = false,
                position_end_time = $1,
                exit_price = $2,
                pnl = $3,
                drift_usdc_balance_at_end = $4,
                updated_at = NOW() AT TIME ZONE 'UTC'
            WHERE position_mint_address = $5
        `;

        const values = [
            closingData.position_end_time,
            closingData.exit_price,
            closingData.pnl,
            closingData.drift_usdc_balance_at_end,
            positionMintAddress
        ];

        await pool.query(query, values);
    }
};

// Initialize database connection
export async function initDb(): Promise<void> {
    try {

        const client = await pool.connect();
        console.log('Successfully connected to database');
        client.release();
    } catch (error) {
        console.error('Error connecting to database:', error);
        throw error;
    }
} 
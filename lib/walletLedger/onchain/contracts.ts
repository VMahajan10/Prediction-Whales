/**
 * Polymarket / Gnosis on-chain contract addresses and event topics.
 *
 * Sources:
 * - Gnosis ConditionalTokens.sol: github.com/gnosis/conditional-tokens-contracts
 * - Polymarket CTF Exchange (PolygonScan verified): 0x4bfb41d5...
 * - Neg Risk CTF Exchange: 0xe2222d279d744050d28e00520010520000310f59
 * - Observed in tx 0x59c3aad5... (d91e identity probe)
 */

/** Polygon USDC.e */
export const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99d7a81a19cb3c11";

/** Gnosis Conditional Tokens (ERC-1155) on Polygon */
export const CONDITIONAL_TOKENS_ADDRESS =
  "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";

/** Polymarket CTF Exchange v1 (binary markets) */
export const CTF_EXCHANGE_V1_ADDRESS =
  "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";

/** Legacy Polymarket CTF Exchange (pre-v1 redeploy; same OrderFilled v1 topic) */
export const CTF_EXCHANGE_LEGACY_ADDRESS =
  "0xc5d563a36ae78145c45a50134d48a1215220f80a";

/** Polymarket Neg Risk CTF Exchange */
export const NEG_RISK_CTF_EXCHANGE_ADDRESS =
  "0xe2222d279d744050d28e00520010520000310f59";

/** Polymarket CTF Exchange v2 (deployed ~2026) */
export const CTF_EXCHANGE_V2_ADDRESS =
  "0xe111180000d2663c0091e4f400237545b87b996b";

/** Polymarket proxy / operator contracts observed in trade receipts */
export const POLYMARKET_PROXY_FACTORY =
  "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";

/** Approximate block when Polymarket CTF Exchange activity became common on Polygon */
export const POLYMARKET_EXCHANGE_INITIAL_BLOCK = 57_000_000;

/** USDC and outcome tokens use 6 decimals on Polymarket */
export const POLYMARKET_TOKEN_DECIMALS = 6;

// ERC-1155 (OpenZeppelin)
export const TOPIC_ERC1155_TRANSFER_SINGLE =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c603240f7b5223c0e7f4";
export const TOPIC_ERC1155_TRANSFER_BATCH =
  "0x4a39dc06d4c0dbbc2d1881ad8fd8cded0b1348ee1a7d7ddf55d0b4a1c50f2ace";

// Gnosis ConditionalTokens.sol
export const TOPIC_CONDITION_PREPARATION =
  "0x3d0ce6e640a883b25a3f6cb065b680a801b183a5516ed05edd3a130e3dc42da1";
export const TOPIC_CONDITION_RESOLUTION =
  "0x4a1384f6d6ea4e2e18596e66fdb9d7e77e5a70d7ed5980a00727e0be9a3bd290";
export const TOPIC_POSITION_SPLIT =
  "0x72c6024289dce58a3500296fcfb8052f775717b5ccdffdc5978fce8120c9a492";
export const TOPIC_POSITIONS_MERGE =
  "0x9bcd548aed4c8d09fd6acf72de164de5a4ea5bd8fe04e9e89ced673dc6b9d354";
export const TOPIC_PAYOUT_REDEMPTION =
  "0x2682012a4a4e07c6edb0e9c08370a417be685dfcdba780e4de5bde6e6494b3ac";

// CTF Exchange v1 — PolygonScan verified ABI
export const TOPIC_ORDER_FILLED_V1 =
  "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";

// Neg Risk exchange — observed in tx 0x59c3aad5...
export const TOPIC_ORDER_FILLED_NEG_RISK =
  "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";

export const TOPIC_ORDERS_MATCHED_NEG_RISK =
  "0x55bb3cade9d43b798a4fe5ffdd05024b2d7870df53920673bfc7e68047cd0ab1";

/** Emitted by proxy wallet contract (observed from 0xd91e... proxy) */
export const TOPIC_PROXY_WALLET_EXECUTION =
  "0xbbed930dbfb7907ae2d60ddf78345610214f26419a0128df39b6cc3d9e5df9b0";

export const EXCHANGE_ADDRESSES = [
  CTF_EXCHANGE_LEGACY_ADDRESS,
  CTF_EXCHANGE_V1_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  CTF_EXCHANGE_V2_ADDRESS,
] as const;

export const ORDER_FILLED_TOPICS = [
  TOPIC_ORDER_FILLED_V1,
  TOPIC_ORDER_FILLED_NEG_RISK,
] as const;

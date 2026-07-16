import './types';

declare module './types' {
  interface TokenRecord {
    /** Last timestamp at which an external market source refreshed price/state. */
    marketUpdatedAt?: number;
  }
}

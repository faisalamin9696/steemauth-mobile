/**
 * Supabase client factory — endpoint resolution + a cached client per
 * project. Used by the control-plane modules (sessions/activity stores).
 *
 * Session MESSAGING does NOT live here: it lives in the relay transport
 * (`lib/messagePlane.ts`, steemauth-relay). This module is the control-plane
 * PostgREST factory for sessions/activity only.
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const DEFAULT_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export interface RealtimeEndpoint {
  url: string;
  key: string;
}

export function getDefaultEndpoint(): RealtimeEndpoint {
  return { url: DEFAULT_URL, key: DEFAULT_KEY };
}

export function hasDefaultEndpoint(): boolean {
  return Boolean(DEFAULT_URL && DEFAULT_KEY);
}

const clients = new Map<string, SupabaseClient>();

/** Get (or create) a cached client for an endpoint. */
export function getSupabaseClient(endpoint: RealtimeEndpoint): SupabaseClient {
  const cacheKey = `${endpoint.url}|${endpoint.key}`;
  const existing = clients.get(cacheKey);
  if (existing) return existing;
  const client = createClient(endpoint.url, endpoint.key, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    realtime: {
      params: { eventsPerSecond: 20 },
    },
  });
  clients.set(cacheKey, client);
  return client;
}

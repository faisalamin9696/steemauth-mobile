// ---------------------------------------------------------------------------
// SteemAuth :: src/lib/avatar.ts
//
// The profile picture steemitimages keeps for an account, served in three
// sizes:
//
//   https://steemitimages.com/u/<account>/avatar/small    64x64
//   https://steemitimages.com/u/<account>/avatar/medium  128x128
//   https://steemitimages.com/u/<account>/avatar/large   512x512
//
// The caller asks for the variant that matches how big the picture is drawn
// (avatarVariantFor does that picking from a pixel size, doubling for
// retina). An account that does not exist still answers 200 with a small
// JSON body instead of a picture, so a failed decode counts as "no picture
// here" — the AccountAvatar component then falls back to the initials it
// already draws.
//
// Caching is expo-image's job (cachePolicy="memory-disk": memory + on-disk,
// survives relaunches — the React Native counterpart of a service-worker
// Cache Storage). This module is URL logic only: dependency-free and safe
// to import anywhere.
// ---------------------------------------------------------------------------

const HOST = 'https://steemitimages.com';

/** the variants steemitimages answers with, smallest first */
export const AVATAR_VARIANTS = ['small', 'medium', 'large'] as const;

export type AvatarVariant = (typeof AVATAR_VARIANTS)[number];

/** steem account names: 3 to 16 characters, lowercase, dots and dashes inside */
const ACCOUNT_RE = /^[a-z0-9][a-z0-9.-]{1,14}[a-z0-9]$/;

/**
 * The URL of one variant, or null when this cannot be an account name.
 * Only the checked name ever reaches the request line, so a stale or edited
 * value can ask for nothing at all instead of for something odd.
 * `medium` is the default: the middle size reads well in most places.
 */
export function avatarUrl(account: unknown, variant: string = 'medium'): string | null {
  const name = String(account ?? '').trim().toLowerCase();
  const size = (AVATAR_VARIANTS as readonly string[]).includes(variant)
    ? (variant as AvatarVariant)
    : 'medium';
  if (!ACCOUNT_RE.test(name)) return null;
  return `${HOST}/u/${name}/avatar/${size}`;
}

/**
 * Which variant a picture drawn `px` logical pixels across should ask for.
 * The pixel budget is doubled first so a retina screen gets a picture it can
 * show 1:1: a 32px card circle sits on the 64px file, a 48px portrait on the
 * 128px file, and anything larger opens the 512px original.
 */
export function avatarVariantFor(px: unknown): AvatarVariant {
  const want = (Number(px) || 0) * 2;
  if (want <= 64) return 'small';
  if (want <= 128) return 'medium';
  return 'large';
}

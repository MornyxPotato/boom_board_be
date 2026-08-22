import { randomBytes, randomUUID } from 'crypto';

// A player's public handle. Broadcast in every roster, used by the engine for
// targeting/display, and doubled as the Socket.IO room name for private
// messages (see GameService). Safe to show everyone -- it is only a handle.
export const generatePlayerId = (): string => randomUUID();

// The private half of a player's credential. Returned exactly once, in the
// create/join ack, to the one requesting socket -- never in a roster payload.
// This is what proves "I am really this player" when reclaiming control after
// a disconnect, and is the thing an attacker who scraped a broadcast
// `playerId` never receives.
export const generateSecret = (): string => randomBytes(32).toString('base64url');

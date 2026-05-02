import SimpleModeEngine from '../domain/modes/SimpleModeEngine';

export type RoomState = 'lobby' | 'position' | 'attack' | 'process' | 'end';

export interface Room {
    code: string;
    hostId: string;
    game: SimpleModeEngine;
    state: RoomState;
    phaseTimer: NodeJS.Timeout | null;
    processTimer: NodeJS.Timeout | null;
}

// 🏆 THE SINGLE SOURCE OF TRUTH
export const activeRooms: Record<string, Room> = {};
export const socketTracker: Record<string, string> = {};
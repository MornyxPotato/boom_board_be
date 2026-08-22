// Someone who entered a room while a game was already running. A spectator is
// NOT a dead player: a dead player is still a board participant (in `players[]`,
// has a rank, just can't act), whereas a spectator never had a tile and won't
// get one this game. They don't count toward `maxPlayers`, the start gate, the
// alive count, or the win check -- they only ride the room's broadcast channel
// until the host resets to lobby, at which point they are promoted to players.
class SpectatorEntity {
    id: string;
    name: string;
    // Same private credential contract as PlayerEntity.secret.
    secret: string;

    constructor(id: string, name: string, secret: string) {
        this.id = id;
        this.name = name;
        this.secret = secret;
    }

    setName(name: string): void {
        this.name = name;
    }
}

export default SpectatorEntity;

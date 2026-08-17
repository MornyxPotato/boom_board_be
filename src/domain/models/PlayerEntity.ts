// Define a custom type for your coordinates!
export type Coordinate = {
    x: number;
    y: number;
};

class PlayerEntity {
    id: string;
    name: string;
    // Private credential. Never leaves the server except in the one create/join
    // ack to the socket that owns it -- keep it out of every roster payload.
    secret: string;
    isAlive: boolean;
    x: number | null;
    y: number | null;
    hasPositioned: boolean;
    bombTarget: Coordinate | null;
    throwOrder: number | null;
    deathOrder: number | null;
    isDisconnected: boolean;

    constructor(id: string, name: string, secret: string) {
        this.id = id;
        this.name = name;
        this.secret = secret;
        this.isAlive = true;

        this.x = null;
        this.y = null;

        this.hasPositioned = false;
        this.bombTarget = null;
        this.throwOrder = null;
        this.deathOrder = null;
        this.isDisconnected = false;
    }

    setPosition(x: number, y: number): void {
        this.x = x;
        this.y = y;
        this.hasPositioned = true;
    }

    setBombTarget(x: number, y: number, order: number): void {
        this.bombTarget = { x, y };
        this.throwOrder = order;
    }

    resetRound(): void {
        this.bombTarget = null;
        this.throwOrder = null;
    }

    // Life status and connection status are orthogonal: losing your client does
    // not take you off the board, and dying does not detach your client. This
    // deliberately never touches `isAlive`/`deathOrder` -- `disconnected + alive`
    // is the whole point of the reconnection feature.
    setDisconnected(flag: boolean): void {
        this.isDisconnected = flag;
    }

    setName(name: string): void {
        this.name = name;
    }

    eliminate(order: number): void {
        this.isAlive = false;
        this.deathOrder = order;
    }

    fullReset(): void {
        this.isAlive = true;
        this.x = null;
        this.y = null;
        this.hasPositioned = false;
        this.bombTarget = null;
        this.throwOrder = null;
        this.deathOrder = null;
        this.isDisconnected = false;
    }
}

export default PlayerEntity;

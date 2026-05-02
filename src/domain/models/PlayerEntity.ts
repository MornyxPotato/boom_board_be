// Define a custom type for your coordinates!
export type Coordinate = {
    x: number;
    y: number;
};

class PlayerEntity {
    id: string;
    name: string;
    isAlive: boolean;
    x: number | null;
    y: number | null;
    hasPositioned: boolean;
    bombTarget: Coordinate | null;
    throwOrder: number | null;
    deathOrder: number | null;
    isDisconnected: boolean;

    constructor(id: string, name: string) {
        this.id = id;
        this.name = name;
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

    eliminate(order: number, disconnected: boolean = false): void {
        this.isAlive = false;
        this.deathOrder = order;
        this.isDisconnected = disconnected;
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
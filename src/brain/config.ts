import "dotenv/config";

const port = Number(process.env.PORT);
const devToken = process.env.DEV_TOKEN;
const timeout_ms = Number(process.env.ACK_TIMEOUT)

if (!port) {
    throw new Error("PORT is not set");
}

if (!devToken) {
    throw new Error("DEV_TOKEN not present, refusing to start...");
}

if (!timeout_ms){
    throw new Error("Timeout not set")
}

export const config = {
    port,
    devToken,
    timeout_ms,
};
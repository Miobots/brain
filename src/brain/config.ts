import "dotenv/config";

const port = Number(process.env.PORT);
const devToken = process.env.DEV_TOKEN;

if (!port) {
    throw new Error("PORT is not set");
}

if (!devToken) {
    throw new Error("DEV_TOKEN not present, refusing to start...");
}

export const config = {
    port,
    devToken,
};
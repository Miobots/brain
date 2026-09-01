import "./server.ts";
import { sendCommand } from "./hub.ts";
import { Topics, Language } from "@miobots/protocol";

await new Promise((resolve) => setTimeout(resolve, 10000));

const ack = await sendCommand(
    "heart-sim-01",
    Topics.VOICE_SPEAK,
    {
        text: "salam",
        lang: Language.UR,
    }
);

console.log("Command completed:", ack);

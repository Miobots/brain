import { WebSocket, WebSocketServer} from "ws";
import { newEnvelope,HelloPayload, parse, Topics,validateHello, createWelcomeAck, encode, Kind } from "@miobots/protocol";
import { env } from "node:process";
import { stat } from "node:fs";
import { config } from "./config.ts";
import { handleAck} from "./hub.ts";
import { deviceCommands } from "./command-store.ts";



const port = config.port
const DEV_TOKEN= config.devToken


export const wss = new WebSocketServer({
    port:config.port,
    path: "/ws",
});
export const devices = new Map<string,WebSocket>();

//TODO1: Make it more modular very dirty looking 
//TODO2: Handle other topics aswell SYS.HEARBEAT 

export function startServer(port:number,dev_Token:string){

    wss.on('connection', (ws)=>{
    //handles new client connections
    let deviceId: string | undefined;


    ws.on('message', (rawdata:string)=>{
        //handles oversized message B0.5 M-50
        if (rawdata.length > config.max_message_size){
            console.log(`[SERVER] Message exceeds maximum size 5MB`)
            return;
        }
        const brain_data = parse(rawdata)
        if (!brain_data.success){
            console.log(`[SERVER] Error: ${brain_data.error}`)
            return;
        }
        const envelope = brain_data.data
        if (envelope.topic==Topics.SYS_HELLO){
            // handshake message
            const validation = validateHello(envelope.payload)
            if(!validation.valid){
                const bad_welcome = createWelcomeAck(envelope,{accepted:false,reason:"invalid payload"})
                ws.send(encode(bad_welcome))
                console.log(`[SERVER] Invalid hello: ${validation.error} closing server`);
                ws.close();
                return;
                
            }
            const hello = envelope.payload as HelloPayload;
            console.log(`[SERVER] Verified hello payload`)
            // dev token check
            if(hello.token!==DEV_TOKEN){
                // authentication failed
                const bad_welcome = createWelcomeAck(envelope,{accepted:false,reason:"Unauthenticated token"})
                ws.send(encode(bad_welcome))
                console.log(`[SERVER] BAD DEV_TOKEN closing server`)
                ws.close();
                return;
            }
            //Device authenticated
            deviceId=hello.device_id
            devices.set(hello.device_id, ws);
            if (!deviceCommands.has(deviceId)) {
                deviceCommands.set(deviceId, new Map());
                }
            console.log(`[SERVER] Device authenticated: ${deviceId}`);
            const welcome = createWelcomeAck(envelope,{accepted:true})
            ws.send(encode(welcome))
            console.log(`[SERVER] welcome Ack Sent`)
        }
        if (envelope.kind===Kind.ACK){
            handleAck(envelope)
            return;
        }
    }
    );
    ws.on("close", ()=>{
        if(deviceId){
            devices.delete(deviceId)
            console.log(`[Server] Device disconnected ${deviceId}`)
        }
    });
    ws.on("error", (err)=>{
        console.log(`[SERVER] Websocket err: ${err}`)
    })
}

);
}
startServer(port,DEV_TOKEN)
console.log(`listening at ws://localhost:${port}/ws...`);
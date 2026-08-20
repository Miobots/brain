import { WebSocket, WebSocketServer} from "ws";
import { newEnvelope,HelloPayload, parse, Topics,validateHello, createWelcomeAck, encode } from "@miobots/protocol";
import { env } from "node:process";


const port = Number(process.env.PORT);

if (!port) {
    throw new Error("PORT is not set");
}

const wss = new WebSocketServer({
    port,
    path: "/ws",
});
const devices = new Map<string,WebSocket>();
const DEV_TOKEN= process.env.DEV_TOKEN
    if (!DEV_TOKEN){
        throw new Error("DEV_TOKEN not present , refusing to start...")
    }

//TODO1: Make it more modular very dirty looking 
//TODO2: Handle other topics aswell SYS.HEARBEAT 

wss.on('connection', (ws)=>{
    //handles new client connections
    let deviceId: string | undefined;


    ws.on('message', (rawdata:string)=>{
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
                console.log(`[SERVER] Invalid hello: ${validation.error}`);
                return;
            }
            const hello = envelope.payload as HelloPayload;
            console.log(`[SERVER] Verified hello payload`)
            // dev token check
            if(hello.token!==DEV_TOKEN){
                // authentication failed
                const welcome = createWelcomeAck(envelope,{accepted:false,reason:"Unauthenticated token"})
                ws.send(encode(welcome))
                console.log(`[SERVER] BAD DEV_TOKEN closing server`)
                ws.close();
                return;
            }
            //Device authenticated
            deviceId=hello.device_id
            devices.set(hello.device_id, ws);
            console.log(`[SERVER] Device authenticated: ${deviceId}`);
            const welcome = createWelcomeAck(envelope,{accepted:true})
            ws.send(encode(welcome))
            console.log(`[SERVER] welcome Ack Sent`)
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
console.log(`listening at ws://localhost:${port}/ws...`);
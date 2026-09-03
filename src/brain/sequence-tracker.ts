

const lastsequence = new Map<string,number>();

export function resetSequencebrain(deviceid:string){
    lastsequence.delete(deviceid);
}

export function checksequence(deviceid:string,seq:number):boolean{
    const last = lastsequence.get(deviceid);
    if (last ===undefined){
        //first message
        lastsequence.set(deviceid,seq)
        return true;
    }
    const expectedsequence= last+1;
    if (seq == expectedsequence){
        lastsequence.set(deviceid,seq);
        return true;
    }
    //packet has been lost
    if (seq> expectedsequence){
        console.warn(
            `[SERVER] SEQUENCE GAP: device=${deviceid} ` +
            `expected=${expectedsequence} received=${seq}`,
        );
        //we continue from the sequence we recieved
        lastsequence.set(deviceid,seq);
        return true;
    }
    if (seq<expectedsequence){
            console.warn(
        `[SERVER] OUT-OF-ORDER MESSAGE: device=${deviceid} ` +
        `expected=${expectedsequence} received=${seq}`,
    );
    //we are still expecting the same next sequence
    //rn we return false 
    }
    return false;
}
import express from "express";
import fs from "fs";
import https from "https";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import CryptoJS from 'crypto-js';
import cors from "cors";

const app = express();
app.use(cors());

const server = https.createServer({
    key: fs.readFileSync('./private-key.pem'),
    cert: fs.readFileSync('./certificate.pem'),
}, app);

const wss = new WebSocketServer({ server });
let clients = [];
let messages = [];

wss.on("connection", ws => {
    ws.on('message', message => handleMessages(message, ws));
    const user = handleConnection(ws);
    ws.send(encryptData(user, 'message'));
    sendClients();
});



/**
 * Send connected message to client with id
 * @param {*} ws 
 * @returns 
 */
function handleConnection( ws){
    const { remoteAddress, remotePort } = ws._socket;
    console.log("New connection from: ", remoteAddress, remotePort);
    let id = uuidv4();
    if(!clients.find(client => client.remoteAddress === remoteAddress && client.remotePort === remotePort)) {
        clients.push({ id, remoteAddress, remotePort, ws, name: setUsername(), lastSeen: new Date(), active: true, type: 'user'});
        createUserFolders(id);
    }else{
        const index = clients.findIndex(client => client.remoteAddress === remoteAddress && client.remotePort === remotePort);
        id = clients[index].id;
        clients[index].ws = ws;
        clients[index].lastSeen = new Date();
        clients[index].active = true;
    }
    const connectedMessage = {
        type: "connected",
        data:{
            clients: getClients(id),
            you: id
        }
    }
    return JSON.stringify(connectedMessage);
}

function handleMessages(message,ws){
    const msg = message.toString();
    const [action, data] = decryptData(msg).split(';');
    if(action === 'upload'){
        const { id, type, name, message, to, targetType } = JSON.parse(data);
        const filePath = path.join(process.cwd(), `uploads/${id}/${type}/${name}`);
        const clientIndex = clients.indexOf(client => client.id === id);
        if(clientIndex !== -1){
            clients[clientIndex].image = filePath;
        }
        const fileStream = fs.createWriteStream(filePath);
        ws.on('message', (chunk) => {
            if(chunk.toString() === 'finish'){
                const receiver = clients.find(client => client.id === to);
                if(receiver){
                    if(targetType === 'group'){
                        messages.push({ from: id, to, message, target: `${to};group`, date: new Date(), type: 'image', src: `uploads/${id}/images/${name}`, targetType: 'group' });
                        receiver.members.forEach(member => {
                            if(member.ws){
                                member.ws.send(encryptData(JSON.stringify({ type: "message", data: getMessages({to}, 'group')}, 'message')));
                            }
                        });
                    }else{
                        messages.push({ from: id, to, message, target: `${to};${id}`, date: new Date(), type: 'image', src: `uploads/${id}/images/${name}`, targetType: 'user' });
                        const msgSend = getMessages({to, from: id}, 'user');
                        receiver.ws.send(encryptData(JSON.stringify({ type: "message", data: msgSend}), 'message'));
                        ws.send(encryptData(JSON.stringify({ type: "message", data: msgSend}), 'message'));
                    }
                    sendClients();
                }
            }
            if (Buffer.isBuffer(chunk)) {
                fileStream.write(chunk);
            }
        });

        ws.on('close', () => {
            
        });
    }
    if(action === 'text'){
        const { from, to, message, targetType } = JSON.parse(data);
        const client = clients.find(client => client.id === to);
        if(client){
            if(targetType === 'group'){
                messages.push({ from, to, message, target: `${to};group`, date: new Date(), type: 'text', targetType: 'group' });
                client.members.forEach(member => {
                    if(member.ws){
                        member.ws.send(encryptData(JSON.stringify({ type: "message", data: getMessages({to}, 'group')}), 'message'));
                    }
                });
            }else{
                messages.push({ from, to, message, target: `${to};${from}`, date: new Date(), type: 'text', targetType: 'user' });
                client.ws.send(encryptData(JSON.stringify({ type: "message", data: getMessages({to, from}, 'user')}), 'message'));
                ws.send(encryptData(JSON.stringify({ type: "message", data: getMessages({to, from}, 'user')}), 'message'));
            }
            sendClients();
        }
    }
    if(action === 'messages'){
        const { from, to, targetType } = JSON.parse(data);  
        ws.send(encryptData(JSON.stringify({ type: "message", data: getMessages({to, from}, targetType)}), 'message'));
    }
    if(action === 'new_group'){
        const {name, members, id} = JSON.parse(data);
        const idGroup = uuidv4();
        const newMembers = members.map(member => {
            const client = clients.find(client => client.id === member);
            return { id: member, name: client.name, ws: client.ws };
        }).concat({ id, name: clients.find(client => client.id === id).name });
        clients.push({ id: idGroup, name, members: newMembers, type: 'group', lastMessage: null });
        sendClients();
    }
}

function getMessages(data, type){
    if(type === 'group'){
        return messages.filter(msg => msg.target.includes(data.to) && msg.targetType === 'group');
    }
    return messages.filter(msg => msg.target.includes(data.to) && msg.target.includes(data.from) && msg.targetType === 'user');
}

function createUserFolders(userId) {
    const baseFolder = path.join(process.cwd(), `uploads/${userId}`);
    const folders = ['documents', 'images', 'images/min', 'profile_pics', 'videos'];
    folders.forEach(folder => {
        const folderPath = path.join(baseFolder, folder);
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }
    });
}

function encryptData(data, type){
    if(type === 'chunk'){
        const base64Chunk = Buffer.from(data).toString('base64');
        const ciphertext = CryptoJS.AES.encrypt(base64Chunk, process.env.PASSWORD_SECRET).toString();
        return ciphertext;
    }else{
        const ciphertext = CryptoJS.AES.encrypt(data, process.env.PASSWORD_SECRET).toString();
        return ciphertext;
    }
}

function decryptData(data){
    try{
        const bytes = CryptoJS.AES.decrypt(data, process.env.PASSWORD_SECRET);
    return bytes.toString(CryptoJS.enc.Utf8);
    }catch{
        return data;
    }
}

app.get('/', (req, res) => {
    res.send('Servidor HTTPS con WebSockets funcionando!');
});

app.get('/uploads', (req, res) => {
    const { pathFile } = req.query;
    const filePath = path.join(process.cwd(), `${pathFile}`);
    if(fs.existsSync(filePath)){
        res.sendFile(filePath);
    }else{
        res.status(404).send('File not found');
    }
});
  
server.listen(41200, () => {
    console.log('Servidor HTTPS con WebSockets escuchando en el puerto 41200');
});

const usernames = [
    'Juan',
    'Pedro',
    'Maria',
    'Jose',
    'Luis',
    'Carlos',
    'Ana',
    'Sofia',
    'Laura',
    'Marta',
]

function setUsername(){
    const user = usernames[Math.floor(Math.random() * usernames.length)];
    if(clients.find(client => client.name === user)){
        setUsername();
    }
    return user;
}

function getClients(c){
    return clients.map(client => {
        const { id, name, active, lastSeen, type } = client;
        const msg = getMessages({to: id, from: c}, type).reverse()[0];
        return { id, name, active, lastSeen, lastMessage: msg, type };
    }).filter(client => client.id !== c);
}

function sendClients(){
    clients.forEach(client => {
        if(client.ws){
            client.ws.send(encryptData(JSON.stringify({ type: "new_client", data: { clients: getClients(client.id)}}), 'message'));
        }
    });
}
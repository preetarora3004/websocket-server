import { createServer } from 'http';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();
const prisma = new PrismaClient();
const port = 8080;
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const client = new Map();
async function broadcastMsg(chatId, msg, excludeuserId) {
    const participant = await prisma.chatParticipant.findMany({
        where: {
            chatId
        },
        select: { userId: true }
    });
    if (participant.length === 0)
        return "Unable to fetch user";
    for (const { userId } of participant) {
        if (userId === excludeuserId)
            continue;
        const clientData = client.get(userId);
        if (!clientData)
            continue;
        const { socket } = clientData;
        if (!socket)
            continue;
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(msg));
        }
    }
}
async function notifyPresence(userId, isAlive) {
    const presenceMsg = JSON.stringify({
        event: "system",
        payload: { userId, isAlive }
    });
    client.forEach((c, id) => {
        if (id !== userId && c.socket.readyState === c.socket.OPEN) {
            c.socket.send(presenceMsg);
        }
    });
}
server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});
wss.on('connection', async (socket, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const tokenFromQuery = url.searchParams.get("token");
    let verification;
    try {
        verification = jwt.verify(tokenFromQuery, process.env.NEXTAUTH_SECRET);
    }
    catch (err) {
        socket.close(1008, "Invalid or expired token");
        return;
    }
    if (!verification) {
        socket.send(JSON.stringify({ type: "Error", message: "Error while decoding" }));
    }
    if (!tokenFromQuery) {
        socket.send(JSON.stringify({ type: "Error", message: "Error" }));
    }
    const senderId = verification.id;
    client.set(senderId, { socket, isAlive: true });
    socket.on("pong", () => {
        const c = client.get(senderId);
        if (c) {
            c.isAlive = true;
            notifyPresence(senderId, true);
        }
    });
    let msg;
    socket.on('message', async (data) => {
        try {
            msg = JSON.parse(data.toString());
        }
        catch (err) {
            socket.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
            return;
        }
        if (msg.event === "chat") {
            const saved = await prisma.message.create({
                data: {
                    content: msg.payload.content, chatId: msg.payload.chatId, senderId: msg.payload.senderId
                },
            });
            broadcastMsg(msg.payload.chatId, {
                event: "chat",
                payload: {
                    senderId: saved.senderId,
                    chatId: saved.chatId,
                    content: saved.content,
                    createdAt: saved.createdAt
                }
            }, saved.senderId);
        }
    });
    socket.on('close', async () => {
        const lastSeen = await prisma.lastSeen.create({
            data: {
                userId: senderId,
                time: new Date()
            }
        });
        console.log("Client disconnected");
    });
});
setInterval(() => {
    client.forEach((c, userId) => {
        if (!c.isAlive) {
            console.log(`user is not responding`);
            c.socket.terminate();
            client.delete(userId);
            notifyPresence(userId, false);
            return;
        }
        c.isAlive = false;
        c.socket.ping();
    });
}, 5000);
server.listen(port, () => {
    console.log(`Server is connected on the Port ${port}`);
});

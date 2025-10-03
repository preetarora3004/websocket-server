import { createServer, IncomingMessage } from 'http';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { client } from '@repo/db';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const prisma = client;
const port = 8080;
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Map<string, ClientData>();

type MsgType = {
    event: "chat";
    payload: {
        chatId: string
        senderId: string;
        content: string;
        createdAt: Date;
    }
}

type ClientData = {
    socket: WebSocket,
    isAlive: boolean
}

async function broadcastMsg(chatId: string, msg: MsgType, excludeuserId?: string): Promise<string | void> {

    const participant = await prisma.chatParticipant.findMany({
        where: {
            chatId
        },
        select: { userId: true }
    })

    if (participant.length === 0) return "Unable to fetch user";

    for (const { userId } of participant) {

        if (userId === excludeuserId) continue;

        const clientData = clients.get(userId);
        if (!clientData) continue;

        const { socket } = clientData;

        if (!socket) continue;

        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(msg));
        }
    }
}

async function notifyPresence(userId: string, isAlive: boolean) {

    const presenceMsg = JSON.stringify({
        event: "system",
        payload: { userId, isAlive }
    })

    clients.forEach((c, id) => {
        if (id !== userId && c.socket.readyState === c.socket.OPEN) {
            c.socket.send(presenceMsg);
        }
    })

}

server.on("upgrade", (req, socket, head) => {
    try {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    } catch (err) {
        socket.destroy();
    }
});

wss.on('connection', async (socket: WebSocket, req: IncomingMessage) => {

    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const tokenFromQuery = url.searchParams.get("token");

    if (!tokenFromQuery) {
        socket.close(1008, "No token provided");
        return;
    }

    if (!process.env.NEXTAUTH_SECRET) {
        throw new Error("NEXTAUTH_SECRET is not defined");
      }

    let verification: JwtPayload;
    try {
        verification = jwt.verify(tokenFromQuery, process.env.NEXTAUTH_SECRET) as JwtPayload
    } catch (err) {
        socket.close(1008, "Invalid or expired token");
        return;
    }

    if (!verification) {
        socket.send(JSON.stringify({ type: "Error", message: "Error while decoding" }))
    }

    const senderId = verification.id;
    clients.set(senderId, { socket, isAlive: true });

    socket.on("pong", () => {

        const c = clients.get(senderId);
        if (c && !c.isAlive) {
            // only broadcast when status changes
            notifyPresence(senderId, true);
        }
        if (c) c.isAlive = true;

    });

    let msg: MsgType
    socket.on('message', async (data: string) => {
        try {
            msg = JSON.parse(data.toString());
        } catch (err) {
            socket.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
            return;
        }

        if (msg.event === "chat") {

            const saved = await prisma.message.create({
                data: {
                    content: msg.payload.content, chatId: msg.payload.chatId, senderId: msg.payload.senderId
                },
            })

            broadcastMsg(msg.payload.chatId, {
                event: "chat",
                payload: {
                    senderId: saved.senderId,
                    chatId: saved.chatId,
                    content: saved.content,
                    createdAt: saved.createdAt
                }
            }, saved.senderId)
        }
    })

    socket.on("close", async () => {
        clients.delete(senderId);
        notifyPresence(senderId, false);
        try {
            await prisma.lastSeen.create({
                data: { userId: senderId, time: new Date() }
            });
        } catch (e) {
            console.error("Failed to save lastSeen", e);
        }
    });

    socket.on("error", (err) => {
        console.error(`Socket error for ${senderId}`, err);
    });
})

setInterval(() => {
    clients.forEach((c, userId) => {
        if (!c.isAlive) {
            console.log(`user is not responding`);
            c.socket.terminate();
            clients.delete(userId);
            notifyPresence(userId, false);
            return;
        }

        c.isAlive = false;
        c.socket.ping();
    })
}, 30000)

server.listen(port, () => {
    console.log(`Server is connected on the Port ${port}`);
})

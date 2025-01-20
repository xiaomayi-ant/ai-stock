import express from 'express';
import cors from 'cors';
import { workflow } from './index.js';
import { BaseMessage } from '@langchain/core/dist/messages';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.use(express.json());

// 移除 X-Powered-By 头
app.disable('x-powered-by');

// 添加请求日志中间件
app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    console.log('Request headers:', req.headers);
    next();
});

// 创建线程端点
app.post('/api/threads', (_req: express.Request, res: express.Response) => {
    const thread_id = `thread_${Math.random().toString(36).substring(2)}`;
    res.json({ thread_id });
});

// 流式响应端点
app.post('/api/threads/:threadId/runs/stream', async (req, res) => {
    try {
        const { input, config } = req.body;
        const threadId = req.params.threadId;
        
        console.log('Received request for thread:', threadId);
        console.log('Input:', JSON.stringify(input));
        
        // 设置响应头以匹配作者的 API
        res.setHeader('access-control-allow-headers', '*');
        res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('transfer-encoding', 'chunked');

        // 创建异步生成器
        async function* generateEvents() {
            // 发送初始消息
            const initialMessages = input.messages.map((msg: any) => ({
                id: Math.random().toString(36).substring(2),
                type: msg.type === 'human' ? 'human' : msg.type === 'ai' ? 'ai' : 'system',
                content: msg.content
            }));
            yield { event: "messages/partial", data: initialMessages };
            
            // 调用LangGraph工作流
            console.log('Calling workflow...');
            const result = await workflow.invoke({
                messages: input.messages
            });
            console.log('Workflow completed');

            // 发送 AI 响应事件
            for (const message of result.messages) {
                if (message._getType() === 'ai') {
                    const messageData = [{
                        type: 'ai',
                        id: `chatcmpl-${Math.random().toString(36).substring(2)}`,
                        content: message.content,
                        tool_calls: (message as any).tool_calls?.map((call: any) => ({
                            id: call.id,
                            name: call.name,
                            args: call.args
                        }))
                    }];
                    yield { event: "messages/partial", data: messageData };
                } else if (message._getType() === 'tool') {
                    const toolData = [{
                        type: 'tool',
                        id: Math.random().toString(36).substring(2),
                        content: message.content,
                        tool_call_id: (message as any).tool_call_id,
                        name: (message as any).name
                    }];
                    yield { event: "messages/partial", data: toolData };
                }
            }

            // 发送完成事件，但不重复发送消息
            yield { event: "messages/complete", data: [] };
        }

        // 处理事件流
        const generator = generateEvents();
        for await (const event of generator) {
            res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }

        // 发送心跳和结束
        res.write(`: heartbeat\n\n`);
        res.end();
        console.log('Response sent and connection closed');
    } catch (error) {
        console.error('Error processing request:', error);
        const errorEvent = {
            error: {
                message: error instanceof Error ? error.message : 'Unknown error',
                type: 'server_error'
            }
        };
        const errorBuffer = Buffer.from(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
        res.write(errorBuffer);
        res.end();
    }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 

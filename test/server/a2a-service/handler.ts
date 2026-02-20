import { v4 as uuidv4 } from 'uuid';
import { Message } from '@a2a-js/sdk';
import { AgentMessageEnvelope, parseDid } from '@agentic-profile/common';
import { JsonRpcRequest, JsonRpcResponse } from '../../../src/json-rpc-client/types.js';
import { JsonRpcRequestContext } from '../../../src/json-rpc-service/types.js';
import { jrpcError, jrpcResult } from '../../../src/json-rpc-service/utils.js';
import { checkJrpcMethod } from '../../../src/a2a-service/lite.js';
//import { pickRandomWelcomeMessage } from './random-hello.js';
import { discoverSynergy } from './discover-synergy.js';

export async function handleA2ALiteRequest(jrpcRequest: JsonRpcRequest, context: JsonRpcRequestContext = {} as any): Promise<JsonRpcResponse> {
    const { session } = context as JsonRpcRequestContext;

    const error = checkJrpcMethod(jrpcRequest, ['message/send']);
    if (error)
        return error;

    const { id, params } = jrpcRequest;
    const userMessage = params.message as Message;
    if (!userMessage)
        return jrpcError(id, -32600, 'Missing message parameter');

    // A2A message and session
    const fromAgentDid = session?.agentDid ?? "unknown";  // might or might not include fragment...

    // open envelope for multi-tenancy support
    const envelope = userMessage.metadata?.envelope as AgentMessageEnvelope | undefined;
    const toAgentDid = envelope?.to;
    if (!toAgentDid)
        throw new Error("Message envelope is missing recipient agent did ('to' property)");
    const { fragment: toFragment } = parseDid(toAgentDid);
    if (!toFragment)
        throw new Error("Invalid toAgentDid, missing fragment: " + toAgentDid);
    if (toFragment !== "venture")
        throw new Error("Invalid toAgentDid, fragment is not 'venture': " + toAgentDid);

    //const text = session ? pickRandomWelcomeMessage() : "Please authenticate, and I will say hello :)";
    const { text, metadata, contextId } = await discoverSynergy({toAgentDid, fromAgentDid, userMessage});

    const agentMessage: Message = {
        kind: "message",
        contextId,
        messageId: uuidv4(),
        role: "agent",
        parts: [
            {
                kind: "text",
                text
            }
        ],
        metadata
    };

    return jrpcResult(id, agentMessage);
}

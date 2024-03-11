import { STREAM_TYPE, CONNECT_TYPE, WispFrame } from "./Types";
import WebSocket, { WebSocketServer } from "ws";
import net, { Socket } from "node:net";
import { IncomingMessage } from "node:http";
import FrameParsers, {
  continuePacketMaker,
  dataPacketMaker,
  maxSize,
  minSize,
} from "./Packets";

const wss = new WebSocket.Server({ noServer: true }); // This is for handling upgrades incase the server doesn't handle them before passing it to us

// Accepts either routeRequest(ws) or routeRequest(request, socket, head) like bare
export async function routeRequest(
  wsOrIncomingMessage: WebSocket | IncomingMessage,
  socket?: Socket,
  head?: Buffer
) {
  if (!(wsOrIncomingMessage instanceof WebSocket) && socket && head) {
    // Compatibility with bare like "handle upgrade" syntax
    wss.handleUpgrade(
      wsOrIncomingMessage,
      socket as Socket,
      head,
      (ws: WebSocket): void => {
        routeRequest(ws);
      }
    );
    return;
  }
  if (!(wsOrIncomingMessage instanceof WebSocket)) return; // something went wrong, abort

  const ws = wsOrIncomingMessage as WebSocket; // now that we are SURE we have a Websocket object, continue...

  const connections = new Map();

  ws.on("message", (data, isBinary) => {
    try {
      // Ensure that the incoming data is a valid WebSocket message
      if (!Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
        console.error("Invalid WebSocket message data");
        return;
      }

      const wispFrame = FrameParsers.wispFrameParser(
        Buffer.from(data as Buffer)
      );

      // Check if the packet is of the correct size
      const payloadSize = wispFrame.payload.length * 8;
      const expectedMaxSize = maxSize[wispFrame.type];
      const expectedMinSize = minSize[wispFrame.type];

      // Minimum packet size check
      if (payloadSize < 8 + 32) {
        console.error("Invalid packet size. Closing connection.");
        ws.close();
        return;
      }

      // Maximum packet size check
      if (
        expectedMaxSize !== undefined &&
        expectedMinSize !== undefined &&
        (payloadSize > expectedMaxSize || payloadSize < expectedMinSize)
      ) {
        // If the size is incorrect, close the connection
        console.error("Invalid packet size. Closing connection.");
        ws.close();
        return;
      }

      // Routing
      if (wispFrame.type == CONNECT_TYPE.CONNECT) {
        // CONNECT frame data
        const connectFrame = FrameParsers.connectPacketParser(
          wispFrame.payload
        );

        // Initialize and register Socket that will handle this stream
        const client = new net.Socket();
        client.connect(connectFrame.port, connectFrame.hostname);
        connections.set(wispFrame.streamID, { client: client, buffer: 127 });

        // Send Socket's data back to client
        client.on("data", function (data) {
          ws.send(FrameParsers.dataPacketMaker(wispFrame, data));
        });

        // close stream if there is some network error
        client.on("error", function () {
          console.error("Something went wrong");
          ws.send(FrameParsers.closePacketMaker(wispFrame, 0x03)); // 0x03 in the WISP protocol is defined as network error
          connections.delete(wispFrame.streamID);
        });
      }
      if (wispFrame.type == CONNECT_TYPE.DATA) {
        const stream = connections.get(wispFrame.streamID);
        stream.client.write(wispFrame.payload);
        stream.buffer--;

        if (stream.buffer == 0) {
          stream.buffer = 127;
          ws.send(continuePacketMaker(wispFrame, stream.buffer));
        }
      }
      if (wispFrame.type == CONNECT_TYPE.CLOSE) {
        // its joever
        console.log(
          "Client decided to terminate with reason " +
            new DataView(wispFrame.payload.buffer).getUint8(0)
        );
        (connections.get(wispFrame.streamID).client as Socket).destroy();
        connections.delete(wispFrame.streamID);
      }
    } catch (e) {
      ws.close(); // something went SUPER wrong, like its probably not even a wisp connection
      console.error(e);
    }
  });

  // Close all open sockets when the WebSocket connection is closed
  ws.on("close", () => {
    for (const { client } of connections.values()) {
      client.destroy();
    }
    connections.clear();
  });

  // SEND the initial continue packet with streamID 0 and 127 queue limit
  ws.send(FrameParsers.continuePacketMaker({ streamID: 0 } as WispFrame, 127));
}

export default {
  routeRequest,
};

import asyncio,sys,websockets
async def main():
 async with websockets.connect('ws://127.0.0.1:42007/download',subprotocols=['neatextension.v1']) as w:
  await w.send(f'1:GET\r\n2:http://127.0.0.1:42080/{sys.argv[1]}\r\n6:{sys.argv[2] if len(sys.argv)>2 else "normal"}\r\n')
  await asyncio.sleep(1)
asyncio.run(main())

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.nio.file.*;
import java.util.*;
public class TraceWindowsReuse extends GhidraScript {
 public void run() throws Exception {
  if(!"60b06db7dfeb6fffb1be82f8ad059d61bdb1b1a3889439b56eaac162e64c0f37".equals(currentProgram.getExecutableSHA256()))throw new IllegalStateException("Unverified binary; address map is version-specific");
  Path root=Paths.get(getScriptArgs()[0]);Files.createDirectories(root);
  StringBuilder report=new StringBuilder(); Set<Function> functions=new LinkedHashSet<>();
  report.append("Executable SHA256: "+currentProgram.getExecutableSHA256()+"\n");
  // The window procedure subtracts 0x40d before this seven-entry switch.
  for(int index=0;index<7;index++) {
   long target=Integer.toUnsignedLong(currentProgram.getMemory().getInt(toAddr(0x4e3ac8L+index*4)));
   report.append(String.format("window message 0x%x -> %08x\n",0x40d+index,target));
  }
  DataIterator all=currentProgram.getListing().getDefinedData(true);
  while(all.hasNext()) { Data d=all.next(); Object value=d.getValue(); if(!(value instanceof String))continue;
   String text=(String)value; String lower=text.toLowerCase();
   if(!(lower.contains("neatextension")||lower.contains("websocket")||lower.equals("resume")||lower.equals("paused")||lower.contains("downloadengine is starting")||lower.contains("downloadengine state changed")||lower.contains("downloadid =")))continue;
   report.append(d.getAddress()+" "+text+"\n");
   for(Reference r:getReferencesTo(d.getAddress())) {Function f=getFunctionContaining(r.getFromAddress());report.append("  "+r.getFromAddress()+" "+(f==null?"no function":f.getName())+"\n");if(f!=null)functions.add(f);}
  }
  for(String address: new String[]{"004e1990","004e2540","004e1c80","004fbb50","004bed30","004be960","004c2e90","00507770","004e3270"}) { Function f=getFunctionAt(toAddr(address));if(f!=null)functions.add(f); }
  InstructionIterator instructions=currentProgram.getListing().getInstructions(true);
  while(instructions.hasNext()) { Instruction ins=instructions.next();for(int i=0;i<ins.getNumOperands();i++)for(Object op:ins.getOpObjects(i)) {
   if(op instanceof ghidra.program.model.scalar.Scalar && ((ghidra.program.model.scalar.Scalar)op).getUnsignedValue()==0x40e) {
    Function f=getFunctionContaining(ins.getAddress()); report.append("message 0x40e: "+ins.getAddress()+" "+ins+" "+(f==null?"none":f.getName())+"\n");if(f!=null)functions.add(f);
   }
  }}
  for(Function target:new ArrayList<>(functions)) {
   report.append("ENTRY "+target.getEntryPoint()+" "+target.getName()+"\n");
   for(Reference ref:getReferencesTo(target.getEntryPoint())) {
    Function caller=getFunctionContaining(ref.getFromAddress());
    report.append("  caller "+ref.getFromAddress()+" "+ref.getReferenceType()+" "+(caller==null?"data":caller.getName())+"\n");
    if(target.getEntryPoint().toString().equals("004fbb50") && caller!=null)functions.add(caller);
   }
  }
  SymbolIterator symbols=currentProgram.getSymbolTable().getSymbolIterator(toAddr("005662c0"),false);
  for(int i=0;i<8 && symbols.hasNext();i++){Symbol symbol=symbols.next();report.append("near pause vtable: "+symbol.getAddress()+" "+symbol.getName(true)+"\n");}
  for(long addr=0x566200;addr<=0x5662d8;addr+=4) {
   long value=Integer.toUnsignedLong(currentProgram.getMemory().getInt(toAddr(addr)));
   Function f=getFunctionAt(toAddr(value));
   if(f!=null)report.append(String.format("vtable candidate %08x -> %08x %s\n",addr,value,f.getName()));
  }
  SymbolIterator allSymbols=currentProgram.getSymbolTable().getAllSymbols(true);
  while(allSymbols.hasNext()) { Symbol symbol=allSymbols.next();
   if(symbol.getName().equals("RegisterClassExW")) {
    for(Reference ref:getReferencesTo(symbol.getAddress())) {
     Function caller=getFunctionContaining(ref.getFromAddress());
     if(caller!=null)functions.add(caller);
     else for(Reference call:getReferencesTo(ref.getFromAddress())) {Function f=getFunctionContaining(call.getFromAddress());if(f!=null){functions.add(f);report.append("RegisterClassExW caller: "+f.getEntryPoint()+"\n");}}
    }
   }
   if(symbol.getName(true).equals("NeatMainWindow::vftable")) {
    report.append("main window vtable: "+symbol.getAddress()+"\n");
    for(int offset=0;offset<0x80;offset+=4) {
     long address=Integer.toUnsignedLong(currentProgram.getMemory().getInt(symbol.getAddress().add(offset)));
     Function candidate=getFunctionAt(toAddr(address));
     report.append(String.format("main slot +%x -> %08x\n",offset,address));
     if(candidate!=null && address>=0x500000 && address<0x510000)functions.add(candidate);
    }
   }
   if(symbol.getName(true).equals("NeatDownloadEngine::vftable")) {
    report.append("engine vtable: "+symbol.getAddress()+"\n");
    long target=Integer.toUnsignedLong(currentProgram.getMemory().getInt(symbol.getAddress().add(4)));
    Function f=getFunctionAt(toAddr(target));report.append(String.format("engine stop slot +4: %08x\n",target));if(f!=null)functions.add(f);
    long stop=Integer.toUnsignedLong(currentProgram.getMemory().getInt(symbol.getAddress().add(0x10)));
    report.append(String.format("engine delegated slot +0x10: %08x\n",stop));Function stopFunction=getFunctionAt(toAddr(stop));if(stopFunction!=null)functions.add(stopFunction);
   }
  }
  long rebuild=Integer.toUnsignedLong(currentProgram.getMemory().getInt(toAddr("005662d4")));
  Function rebuildFunction=getFunctionAt(toAddr(rebuild));if(rebuildFunction!=null)functions.add(rebuildFunction);
  DecompInterface decompiler=new DecompInterface();decompiler.openProgram(currentProgram);
  for(Function f:functions){DecompileResults result=decompiler.decompileFunction(f,60,monitor);if(result.decompileCompleted())Files.writeString(root.resolve(f.getName()+".c"),result.getDecompiledFunction().getC());}
  decompiler.dispose();Files.writeString(root.resolve("string-xrefs.txt"),report.toString());println("Reuse candidate functions: "+functions.size());
 }
}

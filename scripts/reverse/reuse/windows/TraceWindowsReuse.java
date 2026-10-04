import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.nio.file.*;
import java.util.*;
public class TraceWindowsReuse extends GhidraScript {
 public void run() throws Exception {
  Path root=Paths.get(getScriptArgs()[0]);Files.createDirectories(root);
  StringBuilder report=new StringBuilder(); Set<Function> functions=new LinkedHashSet<>();
  DataIterator all=currentProgram.getListing().getDefinedData(true);
  while(all.hasNext()) { Data d=all.next(); Object value=d.getValue(); if(!(value instanceof String))continue;
   String text=(String)value; String lower=text.toLowerCase();
   if(!(lower.contains("neatextension")||lower.contains("websocket")||lower.equals("resume")||lower.equals("paused")||lower.contains("downloadengine is starting")||lower.contains("downloadengine state changed")||lower.contains("downloadid =")))continue;
   report.append(d.getAddress()+" "+text+"\n");
   for(Reference r:getReferencesTo(d.getAddress())) {Function f=getFunctionContaining(r.getFromAddress());report.append("  "+r.getFromAddress()+" "+(f==null?"no function":f.getName())+"\n");if(f!=null)functions.add(f);}
  }
  for(String address: new String[]{"004e1990","004e2540","004e1c80"}) { Function f=getFunctionAt(toAddr(address));if(f!=null)functions.add(f); }
  InstructionIterator instructions=currentProgram.getListing().getInstructions(true);
  while(instructions.hasNext()) { Instruction ins=instructions.next();for(int i=0;i<ins.getNumOperands();i++)for(Object op:ins.getOpObjects(i)) {
   if(op instanceof ghidra.program.model.scalar.Scalar && ((ghidra.program.model.scalar.Scalar)op).getUnsignedValue()==0x40e) {
    Function f=getFunctionContaining(ins.getAddress()); report.append("message 0x40e: "+ins.getAddress()+" "+ins+" "+(f==null?"none":f.getName())+"\n");if(f!=null)functions.add(f);
   }
  }}
  DecompInterface decompiler=new DecompInterface();decompiler.openProgram(currentProgram);
  for(Function f:functions){DecompileResults result=decompiler.decompileFunction(f,60,monitor);if(result.decompileCompleted())Files.writeString(root.resolve(f.getName()+".c"),result.getDecompiledFunction().getC());}
  decompiler.dispose();Files.writeString(root.resolve("string-xrefs.txt"),report.toString());println("Reuse candidate functions: "+functions.size());
 }
}

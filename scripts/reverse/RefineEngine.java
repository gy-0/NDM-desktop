// Refine only an isolated copy of the original Ghidra project.
//@category NDM.Reference
import java.nio.file.*;
import java.util.*;
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.data.*;
import ghidra.program.model.symbol.SourceType;

public class RefineEngine extends GhidraScript {
  void signature(long address, String name, DataType result, DataType... args) throws Exception {
    Function f = getFunctionAt(toAddr(address));
    if (f == null) throw new IllegalStateException("Missing function " + Long.toHexString(address));
    f.setName(name, SourceType.USER_DEFINED);
    f.setReturnType(result, SourceType.USER_DEFINED);
    Parameter[] params = new Parameter[args.length];
    for (int i=0;i<args.length;i++) params[i]=new ParameterImpl(i==0?"self":"arg"+i,args[i],currentProgram);
    f.replaceParameters(Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS,true,SourceType.USER_DEFINED,params);
    f.setComment("Analyst-assigned name/signature; original symbol is stripped. See verified report for evidence and limits.");
  }
  public void run() throws Exception {
    if (!"25031b78644cc3371ad81dd1e675550ae72e221d88f6c0ae167b434025cdc0c7".equals(currentProgram.getExecutableSHA256()))
      throw new IllegalStateException("Wrong reference binary; rederive addresses before applying signatures");
    Path output=Paths.get(getScriptArgs()[0]); Files.createDirectories(output);
    DataType ptr=new PointerDataType(VoidDataType.dataType), i= IntegerDataType.dataType, q=LongLongDataType.dataType, v=VoidDataType.dataType;
    signature(0x100076b90L,"file_read_bytes",i,ptr,ptr,i);
    signature(0x100076d78L,"file_write_bytes",q,ptr,ptr,i);
    signature(0x100024834L,"engine_segment_manager",ptr,ptr);
    signature(0x10005e120L,"segments_have_assignable_work",i,ptr);
    signature(0x10005e1e0L,"segments_estimate_worker_capacity",q,ptr);
    signature(0x10005e2b4L,"segments_largest_splittable_index",i,ptr);
    signature(0x10005f5e8L,"segments_check_all_complete",q,ptr);
    signature(0x1000641e4L,"segment_remaining_bytes",q,ptr);
    signature(0x100063f28L,"segment_start_offset",q,ptr);
    signature(0x100063f30L,"segment_completed_bytes",q,ptr);
    signature(0x100063fc0L,"segment_state_code",i,ptr);
    signature(0x10002471cL,"engine_is_completed",i,ptr);
    signature(0x1000246ecL,"engine_is_starting",i,ptr);
    signature(0x1000237b8L,"engine_is_merging",i,ptr);
    signature(0x100054058L,"socket_segment_complete",v,ptr);
    signature(0x10003bd14L,"http_socket_finish_or_requeue",q,ptr,i,q);
    signature(0x10005e3b8L,"segments_assign_or_split",i,ptr,ptr);
    signature(0x100026428L,"engine_assign_socket_segment",v,ptr,ptr);
    signature(0x100054644L,"socket_is_ready",i,ptr);
    signature(0x100052a30L,"socket_set_state",v,ptr,i);
    long[] targets={0x100076b90L,0x100076d78L,0x100024834L,0x10005e120L,0x10005e1e0L,0x10005e2b4L,0x10005f5e8L,0x1000641e4L,0x100063f28L,0x100063f30L,0x100063fc0L,0x10002471cL,0x1000246ecL,0x1000237b8L,0x100054058L,0x10003bd14L,0x10005e3b8L,0x100026428L,0x100054644L,0x100052a30L,0x1000286fcL,0x100025aa0L,0x1000293ccL,0x10005ec98L,0x10005f66cL,0x100039fb8L,0x1000265dcL,0x100053f50L,0x100054344L,0x100008ce8L,0x100035db0L,0x1000377e4L};
    DecompInterface decompiler=new DecompInterface(); decompiler.openProgram(currentProgram);
    StringBuilder index=new StringBuilder("address\tname\tsuccess\n");
    for(long address:targets){
      Function f=getFunctionAt(toAddr(address)); if(f==null)throw new IllegalStateException("missing target");
      DecompileResults r=decompiler.decompileFunction(f,60,monitor);
      if(!r.decompileCompleted())throw new IllegalStateException(r.getErrorMessage());
      String base=Long.toHexString(address);
      Files.writeString(output.resolve(base+".c"),"/* Analyst-refined reference, not original source. Address 0x"+base+" */\n"+r.getDecompiledFunction().getC());
      StringBuilder asm=new StringBuilder();
      InstructionIterator iter=currentProgram.getListing().getInstructions(f.getBody(),true);
      while(iter.hasNext()){Instruction instruction=iter.next();asm.append(instruction.getAddress()+" "+instruction+"\n");}
      Files.writeString(output.resolve(base+".asm"),asm.toString());
      index.append("0x"+base+"\t"+f.getName()+"\ttrue\n");
    }
    Files.writeString(output.resolve("index.tsv"),index.toString()); decompiler.dispose();
    println("REFINED "+targets.length+" functions");
  }
}

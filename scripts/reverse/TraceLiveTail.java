// Read-only reference extraction. Run against an isolated project copy.
//@category NDM.Reference
import java.nio.file.*;
import java.util.*;
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;

public class TraceLiveTail extends GhidraScript {
  public void run() throws Exception {
    if (!"25031b78644cc3371ad81dd1e675550ae72e221d88f6c0ae167b434025cdc0c7".equals(currentProgram.getExecutableSHA256()))
      throw new IllegalStateException("Reference code hash mismatch");
    Path output = Paths.get(getScriptArgs()[0]); Files.createDirectories(output);
    Set<Function> targets = new LinkedHashSet<>();
    StringBuilder refs = new StringBuilder("target\tfrom\tcaller\ttype\n");
    for (long address : new long[]{0x100063e04L,0x100063f00L,0x100076d78L,0x1000641e4L}) {
      Function target = getFunctionAt(toAddr(address));
      if (target == null) throw new IllegalStateException("Missing target " + Long.toHexString(address));
      targets.add(target);
      for (Reference reference : getReferencesTo(toAddr(address))) {
        Function caller = getFunctionContaining(reference.getFromAddress());
        refs.append(Long.toHexString(address)).append('\t').append(reference.getFromAddress()).append('\t')
          .append(caller == null ? "none" : caller.getEntryPoint()).append('\t').append(reference.getReferenceType()).append('\n');
        if (caller != null) targets.add(caller);
      }
    }
    Files.writeString(output.resolve("references.tsv"),refs.toString());
    if (targets.size() > 40) throw new IllegalStateException("Unbounded caller set: " + targets.size());
    DecompInterface d = new DecompInterface(); d.openProgram(currentProgram);
    try {
      for (Function f : targets) {
        DecompileResults result = d.decompileFunction(f,60,monitor);
        if (!result.decompileCompleted()) throw new IllegalStateException(result.getErrorMessage());
        String name = f.getEntryPoint().toString();
        Files.writeString(output.resolve(name + ".c"),"/* Decompiled reference; not original source. */\n" + result.getDecompiledFunction().getC());
        StringBuilder asm = new StringBuilder();
        InstructionIterator instructions = currentProgram.getListing().getInstructions(f.getBody(),true);
        while (instructions.hasNext()) { Instruction i = instructions.next(); asm.append(i.getAddress()).append(' ').append(i).append('\n'); }
        Files.writeString(output.resolve(name + ".asm"),asm.toString());
      }
    } finally { d.dispose(); }
    println("EXPORTED " + targets.size() + " live-tail reference functions");
  }
}

package dev.eightlines.gauntlet.core.run;

import dev.eightlines.gauntlet.core.model.InvocationContext;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

public final class InvocationContextLease implements AutoCloseable {
  private final AtomicReference<InvocationContext> context;

  public InvocationContextLease(InvocationContext context) {
    this.context = new AtomicReference<>(context);
  }

  public Optional<InvocationContext> get() {
    return Optional.ofNullable(context.get());
  }

  @Override
  public void close() {
    context.set(null);
  }
}

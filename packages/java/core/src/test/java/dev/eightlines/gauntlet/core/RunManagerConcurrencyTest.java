package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.eightlines.gauntlet.core.model.CreateRunRequest;
import dev.eightlines.gauntlet.core.model.Idempotency;
import java.util.ArrayList;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;
import org.junit.jupiter.api.Test;

class RunManagerConcurrencyTest {
  @Test
  void thirtyTwoConcurrentDuplicatesReserveOneFingerprintAndExecuteOnce() throws Exception {
    var fixture = CoreTestFixtures.runManager(Idempotency.OPTIONAL);
    var request =
        new CreateRunRequest(
            fixture.definition().revision(),
            CoreTestFixtures.EMPTY,
            null,
            false,
            "raw-concurrent-key",
            CoreTestFixtures.EMPTY);
    var start = new java.util.concurrent.CountDownLatch(1);
    var tasks = new ArrayList<Callable<String>>();
    for (int index = 0; index < 32; index++) {
      tasks.add(
          () -> {
            start.await();
            var result = fixture.manager().create(fixture.definition().id(), request);
            assertTrue(result.isSuccess());
            return result.run().id();
          });
    }
    try (var pool = Executors.newFixedThreadPool(32)) {
      var futures = tasks.stream().map(pool::submit).toList();
      start.countDown();
      var ids = new java.util.HashSet<String>();
      for (var future : futures) ids.add(future.get());
      assertEquals(1, ids.size());
      String runId = ids.iterator().next();
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
      while (!fixture.manager().get(runId).orElseThrow().state().terminal()
          && System.nanoTime() < deadline) {
        LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
      }
      assertTrue(fixture.manager().get(runId).orElseThrow().state().terminal());
    }
    assertEquals(1, fixture.store().all().size());
    assertEquals(1, fixture.executions().get());
    assertEquals(1, fixture.store().fingerprintCount());
    assertTrue(!fixture.store().containsText("raw-concurrent-key"));
  }
}

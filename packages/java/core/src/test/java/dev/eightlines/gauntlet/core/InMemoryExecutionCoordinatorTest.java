package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.eightlines.gauntlet.core.run.InMemoryExecutionCoordinator;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class InMemoryExecutionCoordinatorTest {
  @Test
  void allowReservationsNeverBlockEachOther() throws Exception {
    var coordinator = new InMemoryExecutionCoordinator();
    try (var first = coordinator.reserve("applications.finalize", "run-1", "allow");
        var second = coordinator.reserve("applications.finalize", "run-2", null)) {
      assertTrue(first.admitted());
      assertTrue(second.admitted());
      first.turn().toCompletableFuture().get(1, TimeUnit.SECONDS);
      second.turn().toCompletableFuture().get(1, TimeUnit.SECONDS);
    }
  }

  @Test
  void forbidRejectsAConcurrentReservationUntilTheLeaseIsReleased() throws Exception {
    var coordinator = new InMemoryExecutionCoordinator();
    var first = coordinator.reserve("applications.finalize", "run-1", "forbid");
    var rejected = coordinator.reserve("applications.finalize", "run-2", "forbid");

    assertTrue(first.admitted());
    assertFalse(rejected.admitted());
    assertFalse(rejected.conflictResolution().toCompletableFuture().isDone());

    first.markPersisted();
    assertTrue(rejected.conflictResolution().toCompletableFuture().get(1, TimeUnit.SECONDS));

    first.close();
    try (var admitted = coordinator.reserve("applications.finalize", "run-3", "forbid")) {
      assertTrue(admitted.admitted());
      admitted.turn().toCompletableFuture().get(1, TimeUnit.SECONDS);
    }
  }

  @Test
  void queueHandsTurnsOutInReservationOrder() throws Exception {
    var coordinator = new InMemoryExecutionCoordinator();
    var first = coordinator.reserve("applications.finalize", "run-1", "queue");
    var second = coordinator.reserve("applications.finalize", "run-2", "queue");
    var third = coordinator.reserve("applications.finalize", "run-3", "queue");
    var order = new ArrayList<String>();
    var started = new CountDownLatch(2);

    try (var pool = Executors.newFixedThreadPool(2)) {
      var secondFuture =
          pool.submit(
              () -> {
                started.countDown();
                second.turn().toCompletableFuture().get(1, TimeUnit.SECONDS);
                synchronized (order) {
                  order.add("run-2");
                }
                second.close();
                return null;
              });
      var thirdFuture =
          pool.submit(
              () -> {
                started.countDown();
                third.turn().toCompletableFuture().get(1, TimeUnit.SECONDS);
                synchronized (order) {
                  order.add("run-3");
                }
                third.close();
                return null;
              });
      assertTrue(started.await(1, TimeUnit.SECONDS));
      assertFalse(secondFuture.isDone());
      assertFalse(thirdFuture.isDone());

      first.turn().toCompletableFuture().get(1, TimeUnit.SECONDS);
      first.close();

      secondFuture.get(1, TimeUnit.SECONDS);
      thirdFuture.get(1, TimeUnit.SECONDS);
    }
    assertEquals(List.of("run-2", "run-3"), order);
  }

  @Test
  void cancellationRemovesAQueuedReservationAndWakesItsWaiter() throws Exception {
    var coordinator = new InMemoryExecutionCoordinator();
    var first = coordinator.reserve("applications.finalize", "run-1", "queue");
    var cancelled = coordinator.reserve("applications.finalize", "run-2", "queue");
    var third = coordinator.reserve("applications.finalize", "run-3", "queue");

    assertTrue(coordinator.requestCancellation("applications.finalize", "run-2"));
    assertTrue(cancelled.cancellationRequested());
    cancelled.turn().toCompletableFuture().get(1, TimeUnit.SECONDS);

    first.close();
    third.turn().toCompletableFuture().get(1, TimeUnit.SECONDS);
    assertFalse(third.cancellationRequested());
    third.close();
    cancelled.close();
  }
}

package dev.eightlines.gauntlet.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import dev.eightlines.gauntlet.core.json.internal.jcs.NumberToJSON;
import java.io.IOException;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

class Rfc8785AppendixBTest {
  @TestFactory
  Stream<DynamicTest> allRfc8785AppendixBRowsMatchThePinnedNumberPort() {
    return Stream.of(
            row("zero", "0000000000000000", "0"),
            row("minus zero", "8000000000000000", "0"),
            row("minimum positive", "0000000000000001", "5e-324"),
            row("minimum negative", "8000000000000001", "-5e-324"),
            row("maximum positive", "7fefffffffffffff", "1.7976931348623157e+308"),
            row("maximum negative", "ffefffffffffffff", "-1.7976931348623157e+308"),
            row("maximum positive integer sample", "4340000000000000", "9007199254740992"),
            row("maximum negative integer sample", "c340000000000000", "-9007199254740992"),
            row("two to the sixty eight", "4430000000000000", "295147905179352830000"),
            row("nan", "7fffffffffffffff", null),
            row("infinity", "7ff0000000000000", null),
            row("below one e twenty three", "44b52d02c7e14af5", "9.999999999999997e+22"),
            row("one e twenty three", "44b52d02c7e14af6", "1e+23"),
            row("above one e twenty three", "44b52d02c7e14af7", "1.0000000000000001e+23"),
            row("below one e twenty one a", "444b1ae4d6e2ef4e", "999999999999999700000"),
            row("below one e twenty one b", "444b1ae4d6e2ef4f", "999999999999999900000"),
            row("one e twenty one", "444b1ae4d6e2ef50", "1e+21"),
            row("below one e minus six", "3eb0c6f7a0b5ed8c", "9.999999999999997e-7"),
            row("one e minus six", "3eb0c6f7a0b5ed8d", "0.000001"),
            row("rounding sample a", "41b3de4355555553", "333333333.3333332"),
            row("rounding sample b", "41b3de4355555554", "333333333.33333325"),
            row("rounding sample c", "41b3de4355555555", "333333333.3333333"),
            row("rounding sample d", "41b3de4355555556", "333333333.3333334"),
            row("rounding sample e", "41b3de4355555557", "333333333.33333343"),
            row("negative small sample", "becbf647612f3696", "-0.0000033333333333333333"),
            row("round to even", "43143ff3c1cb0959", "1424953923781206.2"))
        .map(
            row ->
                DynamicTest.dynamicTest(
                    row.name,
                    () -> {
                      double value = Double.longBitsToDouble(Long.parseUnsignedLong(row.bits, 16));
                      if (row.expected == null) {
                        assertThrows(IOException.class, () -> NumberToJSON.serializeNumber(value));
                      } else {
                        assertEquals(row.expected, NumberToJSON.serializeNumber(value));
                      }
                    }));
  }

  private static Row row(String name, String bits, String expected) {
    return new Row(name, bits, expected);
  }

  private record Row(String name, String bits, String expected) {}
}

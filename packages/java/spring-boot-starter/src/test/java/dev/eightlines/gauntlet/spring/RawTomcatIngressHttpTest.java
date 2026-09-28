package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;

import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import java.io.ByteArrayOutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

class RawTomcatIngressHttpTest {
  private static ConfigurableApplicationContext enabled;
  private static ConfigurableApplicationContext disabled;

  @BeforeAll
  static void startServers() {
    enabled = start(true);
    disabled = start(false);
  }

  @AfterAll
  static void stopServers() {
    if (enabled != null) enabled.close();
    if (disabled != null) disabled.close();
  }

  @Test
  void defaultTomcatRejectsParserLevelMalformedTargetsBeforeTheServletBoundary() throws Exception {
    int port = port(enabled);
    for (String request : hostileRequests(port)) {
      String response = exchange(port, request);
      assertThat(response).startsWith("HTTP/1.1 400");
    }
  }

  @Test
  void disabledGateWinsForCanonicalTargetsThatReachTheServletBoundary() throws Exception {
    int port = port(disabled);
    String response =
        exchange(
            port,
            "GET /_gauntlet/v1/manifest HTTP/1.1\r\nHost: 127.0.0.1:"
                + port
                + "\r\nConnection: close\r\n\r\n");

    assertThat(response).startsWith("HTTP/1.1 503");
    assertThat(response).contains("Content-Type: application/problem+json");
    assertThat(response).contains("urn:gauntlet:problem:adapter-disabled");
  }

  @Test
  void connectorPassesSafeAdapterAndUnrelatedHostRoutesToSpring() throws Exception {
    int serverPort = port(enabled);
    String manifest =
        exchange(
            serverPort,
            "GET /_gauntlet/v1/manifest HTTP/1.1\r\nHost: 127.0.0.1:"
                + serverPort
                + "\r\nConnection: close\r\n\r\n");
    String unrelated =
        exchange(
            serverPort,
            "GET /host-route HTTP/1.1\r\nHost: 127.0.0.1:"
                + serverPort
                + "\r\nConnection: close\r\n\r\n");

    assertThat(manifest).startsWith("HTTP/1.1 200");
    assertThat(unrelated).startsWith("HTTP/1.1 404");
    assertThat(unrelated).doesNotContain("urn:gauntlet:problem:invalid-path");
  }

  @Test
  void starterDoesNotDisableKeepAliveForUnrelatedHostRoutes() throws Exception {
    int serverPort = port(enabled);
    String response =
        exchange(
            serverPort,
            "GET /host-route HTTP/1.1\r\nHost: 127.0.0.1:"
                + serverPort
                + "\r\n\r\nGET /host-route HTTP/1.1\r\nHost: 127.0.0.1:"
                + serverPort
                + "\r\nConnection: close\r\n\r\n");

    assertThat(response.split("HTTP/1.1 404", -1)).hasSize(3);
  }

  private static List<String> hostileRequests(int port) {
    String suffix = " HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\n\r\n";
    return List.of(
        "GET /_gauntlet/v1/operations/unsafe%ZZ" + suffix,
        "GET /_gauntlet/v1/operations/unsafe%2Fid" + suffix,
        "GET /_gauntlet/v1/operations/unsafe\\id" + suffix,
        "GET http://mismatch.example/_gauntlet/v1/manifest" + suffix);
  }

  private static ConfigurableApplicationContext start(boolean enabled) {
    var builder =
        new SpringApplicationBuilder(FixtureApplication.class)
            .properties(
                "server.address=127.0.0.1",
                "server.port=0",
                "spring.main.banner-mode=off",
                "logging.level.root=OFF",
                "gauntlet.enabled=" + enabled);
    if (enabled) {
      builder.properties(
          "gauntlet.application.id=fixture-app",
          "gauntlet.application.label=Fixture application",
          "gauntlet.application.environment.name=fixture-test",
          "gauntlet.application.environment.kind=test",
          "gauntlet.idempotency-secret=fixture-idempotency-secret-32-bytes-long");
    }
    return builder.run();
  }

  private static int port(ConfigurableApplicationContext context) {
    return ((WebServerApplicationContext) context).getWebServer().getPort();
  }

  private static String exchange(int port, String request) throws Exception {
    try (var socket = new Socket()) {
      socket.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 2_000);
      socket.setSoTimeout(5_000);
      socket.getOutputStream().write(request.getBytes(StandardCharsets.ISO_8859_1));
      socket.getOutputStream().flush();
      var response = new ByteArrayOutputStream();
      socket.getInputStream().transferTo(response);
      return response.toString(StandardCharsets.UTF_8);
    }
  }
}

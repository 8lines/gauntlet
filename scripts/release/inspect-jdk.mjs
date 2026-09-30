import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INSPECTOR_FILENAME = "GauntletMavenInspector.java";

export const JDK_INSPECTOR_SOURCE = String.raw`import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

final class GauntletMavenInspector {
  private static final String NS = "http://maven.apache.org/POM/4.0.0";
  private static final long MAX_FILE = 64L * 1024L * 1024L;
  private static final long MAX_JAR_TOTAL = 192L * 1024L * 1024L;
  private static final int MAX_ENTRIES = 20000;
  private static final byte[] CLASS_MAGIC = {(byte) 0xca, (byte) 0xfe, (byte) 0xba, (byte) 0xbe};

  private record Module(String artifact, String publication, String description) {}

  private static final List<Module> MODULES = List.of(
      new Module("core", "Gauntlet Java Core",
          "Framework-neutral Adapter v1 models, validation, registries, and run lifecycle for Gauntlet Java integrations."),
      new Module("spring-boot-starter", "Gauntlet Spring Boot Starter",
          "Spring Boot auto-configuration and Adapter v1 HTTP transport for explicitly registered Gauntlet features."));

  public static void main(String[] args) throws Exception {
    require(args.length == 3);
    Path repository = canonicalDirectory(Path.of(args[0]));
    Path licensePath = canonicalFile(Path.of(args[1]));
    String version = args[2];
    require(version.matches("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"));
    byte[] license = boundedRead(licensePath);
    for (Module module : MODULES) inspectModule(repository, module, version, license);
    System.out.print("MAVEN_INSPECTION_OK\n");
  }

  private static void inspectModule(Path repository, Module module, String version, byte[] license)
      throws Exception {
    Path directory = canonicalDirectory(repository.resolve(
        "dev/eightlines/gauntlet/" + module.artifact() + "/" + version));
    String base = module.artifact() + "-" + version;
    inspectPom(canonicalFile(directory.resolve(base + ".pom")), module, version);
    inspectModuleMetadata(canonicalFile(directory.resolve(base + ".module")), module, version);
    inspectJar(canonicalFile(directory.resolve(base + ".jar")), "binary", module.artifact(), license);
    inspectJar(canonicalFile(directory.resolve(base + "-sources.jar")), "sources", module.artifact(), license);
    inspectJar(canonicalFile(directory.resolve(base + "-javadoc.jar")), "javadoc", module.artifact(), license);
  }

  private static void inspectPom(Path path, Module module, String version) throws Exception {
    byte[] bytes = boundedRead(path);
    String text = new String(bytes, StandardCharsets.UTF_8);
    require(Arrays.equals(bytes, text.getBytes(StandardCharsets.UTF_8)));
    require(!text.contains("SNAPSHOT") && !text.contains("<repositories")
        && !text.contains("<distributionManagement") && !text.matches("(?is).*?(password|username|token|secret|authorization).*"));
    DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
    factory.setNamespaceAware(true);
    factory.setXIncludeAware(false);
    factory.setExpandEntityReferences(false);
    factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
    factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
    Document document;
    try (InputStream input = Files.newInputStream(path)) {
      document = factory.newDocumentBuilder().parse(input);
    }
    Element project = document.getDocumentElement();
    require(NS.equals(project.getNamespaceURI()) && "project".equals(project.getLocalName()));
    require("4.0.0".equals(text(project, "modelVersion")));
    require("dev.eightlines.gauntlet".equals(text(project, "groupId")));
    require(module.artifact().equals(text(project, "artifactId")));
    require(version.equals(text(project, "version")));
    require(module.publication().equals(text(project, "name")));
    require(module.description().equals(text(project, "description")));
    require("https://github.com/8lines/gauntlet".equals(text(project, "url")));

    Element licenses = child(project, "licenses");
    List<Element> licenseEntries = children(licenses, "license");
    require(licenseEntries.size() == 1);
    Element license = licenseEntries.getFirst();
    require("Apache-2.0".equals(text(license, "name")));
    require("https://www.apache.org/licenses/LICENSE-2.0.txt".equals(text(license, "url")));
    require("repo".equals(text(license, "distribution")));

    Element scm = child(project, "scm");
    require("scm:git:https://github.com/8lines/gauntlet.git".equals(text(scm, "connection")));
    require("scm:git:ssh://git@github.com/8lines/gauntlet.git".equals(text(scm, "developerConnection")));
    require("https://github.com/8lines/gauntlet".equals(text(scm, "url")));

    List<String> dependencies = dependencyRecords(child(project, "dependencies", false));
    if (module.artifact().equals("core")) {
      require(dependencies.equals(List.of(
          "com.networknt:json-schema-validator:3.0.4:runtime",
          "tools.jackson.core:jackson-core:3.1.7:runtime",
          "tools.jackson.core:jackson-databind:3.1.7:runtime")));
      require(child(project, "dependencyManagement", false) == null);
    } else {
      require(dependencies.equals(List.of(
          "dev.eightlines.gauntlet:core:" + version + ":compile",
          "org.apache.tomcat.embed:tomcat-embed-core:11.0.25:compile",
          "org.apache.tomcat.embed:tomcat-embed-el:11.0.25:compile",
          "org.apache.tomcat.embed:tomcat-embed-websocket:11.0.25:compile",
          "org.springframework.boot:spring-boot-starter-validation::compile",
          "org.springframework.boot:spring-boot-starter-webmvc::compile")));
      Element management = child(project, "dependencyManagement");
      List<String> managed = dependencyRecords(child(management, "dependencies"));
      require(managed.equals(List.of(
          "org.springframework.boot:spring-boot-dependencies:4.1.1:import:pom",
          "tools.jackson:jackson-bom:3.1.7:import:pom")));
    }
  }

  private static List<String> dependencyRecords(Element dependencies) {
    if (dependencies == null) return List.of();
    List<String> result = new ArrayList<>();
    for (Element dependency : children(dependencies, "dependency")) {
      String record = text(dependency, "groupId") + ":" + text(dependency, "artifactId") + ":"
          + text(dependency, "version", false) + ":" + text(dependency, "scope", false);
      String type = text(dependency, "type", false);
      if (!type.isEmpty()) record += ":" + type;
      result.add(record);
    }
    result.sort(String::compareTo);
    return result;
  }

  private static void inspectModuleMetadata(Path path, Module module, String version) throws Exception {
    byte[] bytes = boundedRead(path);
    String text = new String(bytes, StandardCharsets.UTF_8);
    require(Arrays.equals(bytes, text.getBytes(StandardCharsets.UTF_8)));
    require(text.length() < 1024 * 1024 && text.endsWith("\n"));
    require(text.contains("\"group\": \"dev.eightlines.gauntlet\"")
        && text.contains("\"module\": \"" + module.artifact() + "\"")
        && text.contains("\"version\": \"" + version + "\"")
        && text.contains("\"gradle\": {\n      \"version\": \"9.2.1\""));
    require(!text.contains("SNAPSHOT") && !text.contains("file:")
        && !text.matches("(?is).*?(password|username|token|secret|authorization).*"));
  }

  private static void inspectJar(Path path, String kind, String artifact, byte[] license) throws Exception {
    require(Files.size(path) > 0 && Files.size(path) <= MAX_FILE);
    Set<String> names = new HashSet<>();
    int classes = 0;
    int javaSources = 0;
    boolean index = false;
    long total = 0;
    try (JarFile jar = new JarFile(path.toFile(), false)) {
      var entries = jar.entries();
      int count = 0;
      while (entries.hasMoreElements()) {
        JarEntry entry = entries.nextElement();
        require(++count <= MAX_ENTRIES && safeEntry(entry.getName()) && names.add(entry.getName()));
        if (entry.isDirectory()) continue;
        require(entry.getSize() >= 0 && entry.getSize() <= MAX_FILE);
        total += entry.getSize();
        require(total <= MAX_JAR_TOTAL);
        if (entry.getName().equals("META-INF/LICENSE")) {
          try (InputStream input = jar.getInputStream(entry)) {
            require(Arrays.equals(input.readAllBytes(), license));
          }
        }
        if (entry.getName().endsWith(".class")) {
          classes++;
          try (InputStream input = jar.getInputStream(entry)) {
            byte[] header = input.readNBytes(8);
            require(header.length == 8 && Arrays.equals(Arrays.copyOf(header, 4), CLASS_MAGIC));
            int major = ((header[6] & 0xff) << 8) | (header[7] & 0xff);
            require(major == 65);
          }
        }
        if (entry.getName().endsWith(".java")) javaSources++;
        if (entry.getName().equals("index.html")) index = true;
      }
      require(names.contains("META-INF/LICENSE"));
      require(names.contains("META-INF/NOTICE"));
      if (kind.equals("binary")) require(classes > 0 && javaSources == 0);
      if (kind.equals("sources")) require(javaSources > 0 && classes == 0);
      if (kind.equals("javadoc")) require(index && classes == 0 && javaSources == 0);
      if (kind.equals("binary") && artifact.equals("core")) {
        require(names.contains("META-INF/THIRD_PARTY_NOTICES.md"));
        require(names.contains("META-INF/licenses/json-canonicalization-LICENSE"));
      }
    }
  }

  private static boolean safeEntry(String name) {
    if (name.isEmpty() || name.startsWith("/") || name.contains("\\")) return false;
    for (String part : name.split("/", -1)) {
      if (part.equals(".") || part.equals("..")) return false;
    }
    for (int index = 0; index < name.length(); index++) {
      char value = name.charAt(index);
      if (value < 0x20 || value == 0x7f) return false;
    }
    return true;
  }

  private static Element child(Element parent, String name) {
    Element result = child(parent, name, true);
    require(result != null);
    return result;
  }

  private static Element child(Element parent, String name, boolean required) {
    List<Element> values = children(parent, name);
    require(values.size() <= 1 && (!required || values.size() == 1));
    return values.isEmpty() ? null : values.getFirst();
  }

  private static List<Element> children(Element parent, String name) {
    List<Element> result = new ArrayList<>();
    NodeList nodes = parent.getChildNodes();
    for (int index = 0; index < nodes.getLength(); index++) {
      Node node = nodes.item(index);
      if (node instanceof Element element && NS.equals(element.getNamespaceURI())
          && name.equals(element.getLocalName())) result.add(element);
    }
    return result;
  }

  private static String text(Element parent, String name) {
    return text(parent, name, true);
  }

  private static String text(Element parent, String name, boolean required) {
    Element child = child(parent, name, required);
    if (child == null) return "";
    require(child.getChildNodes().getLength() == 1 && child.getFirstChild().getNodeType() == Node.TEXT_NODE);
    String value = child.getTextContent();
    require(value.equals(value.trim()) && !value.isEmpty());
    return value;
  }

  private static byte[] boundedRead(Path path) throws Exception {
    long size = Files.size(path);
    require(size > 0 && size <= MAX_FILE);
    byte[] bytes = Files.readAllBytes(path);
    require(bytes.length == size);
    return bytes;
  }

  private static Path canonicalDirectory(Path path) throws Exception {
    require(path.isAbsolute() && Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)
        && !Files.isSymbolicLink(path));
    Path real = path.toRealPath(LinkOption.NOFOLLOW_LINKS);
    require(real.equals(path));
    return real;
  }

  private static Path canonicalFile(Path path) throws Exception {
    require(path.isAbsolute() && Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
        && !Files.isSymbolicLink(path));
    Path real = path.toRealPath(LinkOption.NOFOLLOW_LINKS);
    require(real.equals(path));
    return real;
  }

  private static void require(boolean condition) {
    if (!condition) throw new IllegalStateException("Maven publication inspection failed closed");
  }
}
`;

export function writeJdkInspector(directory) {
  const path = join(directory, INSPECTOR_FILENAME);
  writeFileSync(path, JDK_INSPECTOR_SOURCE, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

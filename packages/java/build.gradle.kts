import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.api.artifacts.dsl.LockMode
import org.gradle.api.file.DuplicatesStrategy
import org.gradle.api.publish.PublishingExtension
import org.gradle.api.publish.maven.MavenPublication
import org.gradle.api.tasks.bundling.AbstractArchiveTask
import org.gradle.api.tasks.bundling.Jar
import org.gradle.api.tasks.compile.JavaCompile
import org.gradle.api.tasks.javadoc.Javadoc
import org.gradle.external.javadoc.StandardJavadocDocletOptions
import org.gradle.api.tasks.testing.Test
import org.gradle.api.credentials.PasswordCredentials
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.net.URI

plugins {
    id("com.diffplug.spotless") version "8.10.1" apply false
}

fun projectReleaseVersion(versionFile: java.io.File): String {
    val label = versionFile.relativeTo(rootDir).invariantSeparatorsPath
    val bytes = versionFile.readBytes()
    require(bytes.size in 6..64) { "$label must contain one bounded stable semantic version record" }
    require(bytes.all { it.toInt() in 0..127 }) { "$label must contain ASCII bytes only" }
    val record = bytes.toString(StandardCharsets.US_ASCII)
    require(Regex("""^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\n$""").matches(record)) {
        "$label must contain an exact stable semantic version followed by one LF"
    }
    return record.removeSuffix("\n")
}

val publishableProjects = setOf(":core", ":spring-boot-starter")

fun localPublishingUri(raw: String): URI {
    require(raw.length in 8..4096 && raw.none { it.code < 0x20 || it.code == 0x7f }) {
        "gauntletPublishingRepository must be a bounded canonical file URI"
    }
    val parsed = runCatching { URI(raw) }.getOrElse {
        throw IllegalArgumentException("gauntletPublishingRepository must be a canonical file URI")
    }
    require(
        parsed.scheme == "file" && parsed.rawAuthority == null && parsed.rawUserInfo == null &&
            parsed.rawQuery == null && parsed.rawFragment == null
    ) {
        "gauntletPublishingRepository must be a local file URI without authority, userinfo, query, or fragment"
    }
    val path = runCatching { Path.of(parsed) }.getOrElse {
        throw IllegalArgumentException("gauntletPublishingRepository must be a canonical absolute file URI")
    }
    require(
        path.isAbsolute && path.normalize() == path && Files.isDirectory(path) &&
            !Files.isSymbolicLink(path) && path.toRealPath() == path
    ) {
        "gauntletPublishingRepository must name an existing canonical local directory"
    }
    return path.toUri()
}

allprojects {
    group = "dev.eightlines.gauntlet"
    repositories { mavenCentral() }
}

subprojects {
    apply(plugin = "java-library")
    // Publishable projects own their version file; internal projects follow :core.
    version =
        if (path in publishableProjects) projectReleaseVersion(project.file("VERSION"))
        else projectReleaseVersion(rootProject.file("core/VERSION"))
    extensions.configure<JavaPluginExtension> {
        toolchain { languageVersion = JavaLanguageVersion.of(21) }
    }
    tasks.withType<JavaCompile>().configureEach {
        options.release = 21
        options.compilerArgs.add("-parameters")
        options.compilerArgs.add("-Xlint:deprecation")
    }
    dependencies {
        add("testImplementation", "org.junit.jupiter:junit-jupiter:6.0.3")
        add("testRuntimeOnly", "org.junit.platform:junit-platform-launcher:6.0.3")
    }
    tasks.withType<Test>().configureEach { useJUnitPlatform() }
    dependencyLocking {
        lockAllConfigurations()
        lockMode.set(LockMode.STRICT)
    }

    if (path in publishableProjects) {
        apply(plugin = "maven-publish")
        extensions.configure<JavaPluginExtension> {
            withSourcesJar()
            withJavadocJar()
        }
        tasks.withType<AbstractArchiveTask>().configureEach {
            isPreserveFileTimestamps = false
            isReproducibleFileOrder = true
        }
        tasks.withType<Jar>().configureEach {
            duplicatesStrategy = DuplicatesStrategy.FAIL
            from(rootProject.file("../../LICENSE")) {
                into("META-INF")
                rename { "LICENSE" }
            }
            from(rootProject.file("../../NOTICE")) {
                into("META-INF")
                rename { "NOTICE" }
            }
        }
        tasks.withType<Javadoc>().configureEach {
            options.encoding = "UTF-8"
            options.locale = "en_US"
            (options as StandardJavadocDocletOptions).addBooleanOption("notimestamp", true)
            (options as StandardJavadocDocletOptions).addBooleanOption("quiet", true)
            (options as StandardJavadocDocletOptions).addBooleanOption("Xdoclint:none", true)
        }
        extensions.configure<PublishingExtension> {
            repositories {
                val local = providers.gradleProperty("gauntletPublishingRepository").orNull
                val remote = providers.gradleProperty("gauntletRemotePublishing").orNull
                require(local == null || remote == null) {
                    "local and remote Gauntlet publication modes are mutually exclusive"
                }
                if (local != null) {
                    maven {
                        name = "gauntletLocal"
                        url = uri(localPublishingUri(local))
                    }
                } else if (remote != null) {
                    require(remote == "true") {
                        "gauntletRemotePublishing must be exactly true when present"
                    }
                    maven {
                        name = "gauntletRemote"
                        url = uri("https://maven.pkg.github.com/8lines/gauntlet")
                        credentials(PasswordCredentials::class)
                    }
                }
            }
            publications.withType<MavenPublication>().configureEach {
                pom {
                    url.set("https://github.com/8lines/gauntlet")
                    licenses {
                        license {
                            name.set("Apache-2.0")
                            url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                            distribution.set("repo")
                        }
                    }
                    scm {
                        connection.set("scm:git:https://github.com/8lines/gauntlet.git")
                        developerConnection.set("scm:git:ssh://git@github.com/8lines/gauntlet.git")
                        url.set("https://github.com/8lines/gauntlet")
                    }
                }
            }
        }
    }
}

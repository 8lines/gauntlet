import org.gradle.api.artifacts.dsl.LockMode

plugins {
    application
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

dependencies {
    implementation("dev.8lines.gauntlet:spring-boot-starter:0.2.0")
}

dependencyLocking {
    lockAllConfigurations()
    lockMode.set(LockMode.STRICT)
}

application {
    mainClass = "dev.eightlines.gauntlet.consumer.PublishedConsumer"
}

tasks.withType<JavaCompile>().configureEach {
    options.release = 21
    options.encoding = "UTF-8"
}

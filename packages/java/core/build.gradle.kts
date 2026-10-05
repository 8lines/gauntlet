import org.gradle.api.tasks.testing.Test

plugins {
    id("com.diffplug.spotless")
    id("maven-publish")
}

dependencies {
    implementation("com.networknt:json-schema-validator:3.0.8")
    implementation("tools.jackson.core:jackson-core:3.2.3")
    implementation("tools.jackson.core:jackson-databind:3.2.3")
}

spotless {
    java {
        target("src/main/java/**/*.java", "src/test/java/**/*.java")
        targetExclude("src/main/java/**/json/internal/jcs/*.java")
        googleJavaFormat("1.36.1")
    }
}

tasks.processResources {
    from("THIRD_PARTY_NOTICES.md") {
        into("META-INF")
    }
    from("THIRD_PARTY_LICENSES") {
        into("META-INF/licenses")
    }
}

val protocolFixtures = providers.systemProperty("gauntletProtocolFixtures")
sourceSets.named("test") {
    if (protocolFixtures.isPresent) {
        resources.srcDir(protocolFixtures)
    }
}
tasks.named<Test>("test") {
    jvmArgs("-Xss256k")
    systemProperty("gauntletProtocolFixtures", protocolFixtures.getOrElse(""))
    if (project.hasProperty("jcsCorpus")) {
        systemProperty("jcsCorpus", project.property("jcsCorpus").toString())
    } else {
        filter { excludeTestsMatching("*Rfc8785NumberCorpusTest") }
    }
    doFirst {
        require(protocolFixtures.isPresent) {
            "-DgauntletProtocolFixtures must name the mounted protocol fixture directory"
        }
    }
}

publishing {
    publications {
        create<MavenPublication>("core") {
            from(components["java"])
            artifactId = "core"
            pom {
                name.set("Gauntlet Java Core")
                description.set("Framework-neutral Adapter v1 models, validation, registries, and run lifecycle for Gauntlet Java integrations.")
            }
        }
    }
}

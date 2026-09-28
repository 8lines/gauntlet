plugins {
    id("org.springframework.boot") version "4.1.1"
    id("com.diffplug.spotless")
}
dependencies {
    implementation(project(":spring-boot-starter"))
    implementation(platform("org.springframework.boot:spring-boot-dependencies:4.1.1"))
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-validation")
}
springBoot { mainClass = "dev.eightlines.gauntlet.example.FixtureApplication" }

spotless {
    java {
        target("src/main/java/**/*.java")
        googleJavaFormat("1.36.1")
    }
}

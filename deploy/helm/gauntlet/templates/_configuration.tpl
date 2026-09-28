{{- define "gauntlet.configuration" -}}
{{- $targetIDs := dict -}}
{{- range .Values.config.targets -}}
{{- if hasKey $targetIDs .id -}}
{{- fail "Gauntlet configuration contains duplicate target IDs" -}}
{{- end -}}
{{- $_ := set $targetIDs .id true -}}
{{- end -}}
{{- $configuration := toYaml .Values.config | trimSuffix "\n" -}}
{{- if gt (len $configuration) 983040 -}}
{{- fail "Gauntlet configuration exceeds the 983040-byte chart limit" -}}
{{- end -}}
{{- $configuration -}}
{{- end -}}

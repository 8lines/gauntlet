{{- define "gauntlet.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gauntlet.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "gauntlet.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "gauntlet.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gauntlet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name | trunc 63 | trimSuffix "-" | quote }}
{{- end -}}

{{- define "gauntlet.labels" -}}
helm.sh/chart: {{ include "gauntlet.chart" . }}
{{ include "gauntlet.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/component: control-plane
app.kubernetes.io/part-of: gauntlet
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "gauntlet.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "gauntlet.persistentVolumeClaimName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- include "gauntlet.fullname" . -}}
{{- end -}}
{{- end -}}

{{- /* Fails the render for environment settings the server would reject or silently shadow. */ -}}
{{- define "gauntlet.validateEnvironment" -}}
{{- $names := dict -}}
{{- range .Values.extraEnv -}}
{{- if hasKey $names .name -}}
{{- fail "extraEnv names must be unique" -}}
{{- end -}}
{{- $_ := set $names .name true -}}
{{- end -}}
{{- if and .Values.auth.existingSecret (hasKey $names "GAUNTLET_AUTH_SECRET") -}}
{{- fail "Set GAUNTLET_AUTH_SECRET through auth.existingSecret or through extraEnv, not both" -}}
{{- end -}}
{{- if and (eq (include "gauntlet.authMode" .) "password") (not .Values.auth.existingSecret) (not (hasKey $names "GAUNTLET_AUTH_SECRET")) (not .Values.envFrom) -}}
{{- fail "config.auth.mode password needs GAUNTLET_AUTH_SECRET: set auth.existingSecret to a Secret with that key" -}}
{{- end -}}
{{- end -}}
